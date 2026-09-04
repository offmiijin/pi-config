# pi-memory

Memória persistente do agente para pi: extração automática em background de
lições duráveis (regras, decisões, gotchas, lessons, patterns) a partir das
sessões de codificação.

## Visão geral

A cada turno, o pi-memory captura o episódio (o prompt do usuário até a
resposta final), normaliza as evidências (o que foi lido, editado, executado,
corrigido) e — quando há material suficiente — um **worker em background**
chama um LLM dedicado para extrair memórias duráveis. O resultado é validado
por uma camada determinística, revisado condicionalmente por um segundo
passo do LLM, e gravado como **snapshot consolidado** (markdown v2 + índice
FTS5).

Nada disso bloqueia o agente: a captura é leve (metadados + classificação) e
a extração roda assíncrona.

```
┌──────────────────────────────┐
│ agent_settled (fim do turno) │
│  ├─ branch da sessão JSONL   │
│  └─ episódio (fingerprint)   │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Evidências (.pipeline.sqlite)│ ← normalized: correction, response,
│  ├─ code-change, command, …  │    code-change, command, tool, …
│  └─ pending → normalized     │
└──────────────┬───────────────┘
               ▼  gatilhos: tokens / episódios / sinal forte / manual
┌──────────────────────────────┐
│ Worker assíncrono (fila)     │ ← retry 0s→30s→2min→dead_letter
│  ├─ seleciona episódios      │
│  └─ processa o job           │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Extração LLM (modelo configurável)│ ← prompt curado + cache de prompt
│  ├─ busca memórias próximas  │
│  └─ JSON de candidatos       │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Validação + revisor          │ ← determinística + LLM condicional
│  ├─ auto-accept / review /   │
│  │  reject (top 8 por job)   │
│  └─ commit (job.projectId)   │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Memória ativa (markdown v2)  │ ← snapshot consolidado
│  ├─ .history/ (revisões)     │    escrita atômica (.tmp + rename)
│  ├─ .supersedes/ (obsol.)    │
│  └─ .index.sqlite (FTS5)     │
└──────────────────────────────┘
```

## Instalação

A extensão já vive em `~/.pi/agent/extensions/pi-memory/` e é carregada
automaticamente quando o pi inicia. Não há dependências de sistema — os
arquivos SQLite (`.pipeline.sqlite`, `.index.sqlite`) e as memórias markdown
são criados sob `~/.pi/agent/memories/`.

A extração requer um modelo com auth configurada (ver [Configuração]).

## Como funciona

### 1. Captura (Fase 0-1) — por turno, sem LLM

No evento `agent_settled`, o pi-memory:

1. Reconstrói o branch da sessão e encontra o último prompt do usuário.
2. Cria um **episódio** (`insertEpisode`) com fingerprint do range
   (`buildEpisodeFingerprint`) — dedup: o mesmo turno reemitido não duplica.
3. Normaliza o episódio (`normalizeEpisode`): lê o JSONL, classifica as
   entradas em **evidências** e grava no `.pipeline.sqlite`:

| Evidência | Origem |
|---|---|
| `correction` | prompt do usuário com padrão de correção ("não", "na verdade", "errado"…) |
| `prompt` / `response` | mensagens de usuário / assistente |
| `code-change` | tool calls `edit`, `write` (com diff) |
| `command` | tool call `bash` (com exit code) |
| `research` | `read`, `grep`, `find`, `ls` |
| `memory-op` | `memory_save`, `memory_search`, `memory_read`, `memory_decay`, `memory_extract`, `memory_retention` |
| `tool` / `context` | outras tool calls e contexto |

Toda evidência passa por `sanitizeEvidenceText` (segredos viram
`[REDACTED]`: chaves `sk-`/`ghp_`, `Authorization: Basic`, URLs com
credenciais `user:pass@`, chaves privadas PEM, `api_key=...`).

### 2. Fila de jobs (Fase 2) — gatilhos

Um job de extração é criado quando:

| Gatilho | Condição (padrão) |
|---|---|
| Tokens | ≥ 10.000 tokens de episódios `normalized` |
| Episódios | ≥ 5 episódios `normalized` |
| Sinal forte | episódio com correção do usuário ou comando com erro |
| Manual | `memory_extract` (força job; recusa se não há episódios elegíveis) |

O **worker** consome um job por vez (do projeto ativo). Falha transitória →
retry com backoff `0s → 30s → 2min`; após 4 tentativas → `dead_letter`.
Crash/reload deixa o job em `processing` → `recoverStuckJobs` o devolve à
fila no próximo `session_start` (o mesmo vale para jobs `done` com
candidatos `pending`).

### 3. Extração LLM (Fase 3) — modelo dedicado

O prompt é montado com:

- Evidências dos episódios selecionados (alvo ~12K tokens, cap 18K);
- Até 8 memórias relacionadas via FTS5 (contexto para reutilizar chaves,
  `update` ou `supersede` em vez de duplicar);
- Regras: PT-BR, confidence ≥ 0.5, evidência obrigatória (`evidence_ids`),
  sem segredos/status temporário/trivialidades.

O modelo responde um JSON de candidatos (`create` / `update` / `supersede` /
`ignore`), validado contra schema TypeBox. Resposta vazia/JSON inválido não é
sucesso: o job volta para retry.

### 4. Validação + revisor (Fase 4)

1. **Limite**: top 8 candidatos por job (por confidence) — o excedente é
   rejeitado sem chamar o LLM.
2. **Validação determinística** (`validateCandidate`): tipo, escopo,
   confidence ∈ [0.5, 1], tamanho, segredos, PT-BR, `evidence_ids` válidos,
   ação × estado atual (create com key existente → erro).
3. **Política** (`classifyCandidate`):

| Decisão | Quando |
|---|---|
| `reject` | erro determinístico ou confidence < 0.5 |
| `review` | `_rules`, escopo `global`, `supersede`, `update` de memória existente, soft issue, confidence < 0.75 |
| `auto-accept` | o resto (create project com confidence alto) |

4. **Revisor** (`runReviewer`): segundo passe do LLM (mesmo modelo,
   reasoning low, ~3K tokens de evidências relevantes) que decide
   `accept` / `modify` / `reject`. O `modify` é **revalidado** pela camada
   determinística antes do commit.
5. **Commit**: `saveMemory(job.projectId, …)` — usa o projeto do JOB, não o
   global (troca de projeto durante extração é segura).

Candidatos `pending` (revisor/commit falhou) tornam o job **retryável** —
nunca ficam órfãos.

### 5. Gravação — snapshot consolidado (Fase 5)

Toda escrita é uma reescrita do estado atual:

```
memories/
├── _global/<type>/<context>.md          ← memórias globais
├── projects/<projectId>/<type>/<context>.md
├── .git/                                 ← repositório Git aninhado
├── .gitignore                            ← bancos e temporários ignorados
├── .history/<path>/v{N}.md              ← versão anterior (revisões)
├── .supersedes/<path>                   ← memória substituída por OUTRA chave
├── .pipeline.sqlite                     ← episódios/evidências/jobs/candidatos
└── .index.sqlite                        ← FTS5/BM25 (derivado)
```

- Escrita **atômica**: conteúdo novo vai para `.tmp` e é `rename`ado sobre o
  ativo — falha no meio nunca deixa a memória sem versão.
- A versão anterior é arquivada em `.history/` com `revision+1`.
- O frontmatter guarda `summary` (estado atual, usado para dedup futuro),
  `confidence`, `tags`, `evidence`.
- `supersedes` move a memória da outra chave para `.supersedes/`.

### 5b. Versionamento Git

`memories/` possui um repositório Git aninhado e independente do repositório do
código. O repositório é inicializado de forma idempotente no `session_start`;
memórias existentes entram no baseline inicial. Apenas Markdown e arquivos de
configuração do repositório são versionados; SQLite, WAL e temporários ficam no
`.gitignore` interno.

Cada mutação lógica persistida gera um commit com os paths afetados (memória
ativa, `.history/` e/ou `.supersedes/`). A convenção é:

```text
[<project-id>] mem(<global|projects>/<tipo>): <ação> <context>
```

Exemplo: `[github-offmiijin_offmiijin_pi-config] mem(projects/decisions):
atualiza pi-memory-git`. Falhas de commit não desfazem o Markdown canônico;
a operação fica registrada para recuperação no próximo início.

A tool `memory_git` permite inspeção somente leitura de `status`, `log`, `diff`,
`show` e `grep`. Restaurações deliberadas continuam sendo operações manuais no
repositório `memories/`.

### 6. Busca e tools (Fase 6)

- `memory_search` → FTS5/BM25 (fallback ripgrep), escopos `global`/`project`/`all`.
- `memory_read` → lê o markdown completo da memória ativa, fonte da verdade no disco; use após `memory_search` quando o trecho não for suficiente.
- `memory_status` → métricas do pipeline (episódios por status, evidências,
  jobs, candidatos pending, última extração com tokens).
- `memory_extract` → normaliza pendings + enfileira job forçado (assíncrono,
  retorna `job_id` imediatamente).
- `memory_save` / `memory_decay` → escrita/decay de memórias (snapshot).
- `memory_retention` → status/preview/run do decay por inatividade (feature
  flag — ver [Retenção por inatividade]).
- `memory_git` → inspeção read-only do repositório Git de memórias.

### 6b. Retenção por inatividade (feature flag)

Memórias que nunca são usadas perdem **relevância operacional** (`retention_score`),
mas **não** perdem certeza factual: `confidence` só muda via `memory_decay` manual e
nada é movido para `.supersedes/` automaticamente. O desuso apenas rebaixa a
prioridade da memória na ordenação da busca (critério secundário, depois de BM25
e confidence).

- Cada `memory_search` com resultados e cada `memory_read` registra uso em `.retention.sqlite`
  (`last_used_at`, `use_count`) e reseta o score para 1.0.
- O `RetentionScheduler` (independente do worker de extração) faz sweep diário:
  reconcile (espelhar arquivos ativos) → recompute (fórmula de meia-vida com
  grace period) → apply no índice FTS.
- Frontmatter v3: `memory_id` (identidade estável) e `retention_policy`
  (`normal` | `protected`; `_rules` → `protected`).
- Configuração: `RETENTION_ENABLED` (default `false`), `RETENTION_GRACE_DAYS` (30),
  `RETENTION_HALF_LIFE_DAYS` (90), `RETENTION_MIN_SCORE` (0.05).

```
memory_search ──> resultados ──> recordAccess(path) ──> .retention.sqlite
                                                         ├─ last_used_at
                                                         ├─ use_count
                                                         └─ retention_score
RetentionScheduler ── sweep (reconcile → recompute → apply no índice)
```

O sweep nunca altera markdown nem confidence. Detalhes em `docs/retention.md`.

O índice de memórias é injetado no system prompt (`before_agent_start`) e
invalidado a cada escrita.

## Configuração

### Modelo de extração (`config.ts` + `memory/config.ts`)

O modelo padrão continua sendo `opencode-go/deepseek-v4-flash`, mas pode ser
alterado pelo usuário com `/memory config`. O comando abre um menu de
configuração extensível; em seguida, a opção **Model processor** mostra apenas
modelos autenticados no `pi`, usando o catálogo e o `modelRegistry` da sessão.
A seleção é persistida em `~/.pi/agent/memory-config.json` como referência
`provider` + `id`; credenciais nunca são copiadas. A alteração vale para os
próximos jobs e não altera o modelo interativo selecionado via `/model`.

| Constante | Valor | Efeito |
|---|---|---|
| `EXTRACTION_MODEL_PROVIDER` / `ID` | `opencode-go` / `deepseek-v4-flash` | modelo padrão quando não há configuração do usuário |
| `EXTRACTION_REASONING` | `low` | `medium` devolvia só reasoning sem resposta (75% vazio em teste real) |
| `EXTRACTION_CACHE_RETENTION` | `short` | cache de prompt habilitado |
| `EXTRACTION_SESSION_ID` | `pi-memory-extraction` | chave fixa do `prompt_cache_key` (cache reutilizável) |
| `EXTRACTION_MAX_OUTPUT_TOKENS` | `4_096` | teto de saída por chamada (extração + revisor) |
| `EXTRACTION_MAX_CANDIDATES_PER_JOB` | `8` | top N por confidence, excedente rejeitado |

A autenticação é reutilizada diretamente do `pi`. Não há reautenticação quando
o provider/modelo já está autenticado no `modelRegistry`; modelos sem
autenticação não aparecem no seletor.

### Gatilhos e retry (`pipeline/worker.ts`)

`DEFAULT_ELIGIBLE_TOKENS = 10_000`, `DEFAULT_ELIGIBLE_EPISODES = 5`,
`DEFAULT_MAX_ATTEMPTS = 4`, `DEFAULT_BACKOFF_MS = [0, 30_000, 120_000]`,
seleção alvo 12K / cap 18K tokens.

### Retenção por inatividade (`constants.ts`)

| Constante | Valor | Efeito |
|---|---|---|
| `RETENTION_ENABLED` | `false` | feature flag — módulo desativado por padrão (rollout seguro) |
| `RETENTION_GRACE_DAYS` | `30` | sem decay antes deste período sem uso |
| `RETENTION_HALF_LIFE_DAYS` | `90` | score cai pela metade a cada 90 dias de desuso |
| `RETENTION_MIN_SCORE` | `0.05` | piso do score |
| `RETENTION_SWEEP_INTERVAL_MS` | `24h` | intervalo do sweep periódico |

## Testes

```bash
cd ~/.pi/agent/extensions/pi-memory
bun test            # 410 testes (Bun)
npm run typecheck   # tsc strict
```

- **Unit/integração** (`tests/`): 27 arquivos cobrindo pipeline (episódios,
  jobs, worker, retry), extração/validação (processor, validator, extractor),
  memória (CRUD, snapshot, migração v1→v2, escrita atômica, Git), índice FTS,
  retenção (algoritmo, store, scheduler, tool, frontmatter v3), evidências
  (sanitização de segredos), schemas e tools.
- **E2E real** (`e2e/e2e-real.ts`): script manual que roda o pipeline
  completo com **LLM real** (sessão JSONL → evidências → job → candidatos →
  revisor → commit → FTS) e faz self-cleanup:

```bash
node e2e/e2e-real.ts
```

> ⚠️ O E2E chama o modelo de verdade (consome tokens) — não faz parte do
> `npm test` de propósito.

## Estrutura do código

```
extensions/pi-memory/
├── index.ts            entry point (event handlers + wiring de deps)
├── config.ts           defaults e parâmetros da extração (Fase 3)
├── command-completions.ts autocomplete de `/memory info`
├── constants.ts        constantes + setup de diretórios
├── db.ts               driver SQLite (node/bun)
├── schemas.ts          schemas TypeBox das tools
├── session.ts          helpers de sessão (hash, tokens)
├── pipeline/           núcleo do pipeline
│   ├── pipeline.ts     .pipeline.sqlite (episódios, evidências, jobs, candidatos)
│   ├── evidence.ts     normalização de evidências (Fase 1)
│   ├── worker.ts       fila de jobs + consumer assíncrono (Fase 2)
│   ├── extractor.ts    prompt de extração + parsing (Fase 3)
│   ├── processor.ts    extração → validação → commit (Fases 3-4)
│   └── validator.ts    validação/política/revisor (Fase 4)
├── memory/             CRUD de memórias
│   ├── config.ts        configuração persistente do modelo do processor
│   ├── memory.ts       saveMemory, snapshot v2/v3, migração, arquivamento
│   ├── memory-git.ts    repositório Git aninhado e commits de mutação
│   ├── memory-index.ts índice FTS5 (.index.sqlite) com retention_score
│   ├── memory-search.ts fallback de busca via ripgrep
│   ├── retention.ts    algoritmo de retenção (funções puras)
│   ├── retention-store.ts .retention.sqlite (atividade de uso)
│   └── retention-scheduler.ts sweep periódico de retenção
├── tools/              tools e comando /memory config, memory_git
├── tests/              27 arquivos de teste
├── docs/               arquitetura (retention.md)
└── e2e/                E2E manual com LLM real
```

## Limitações

- A extração depende do modelo configurado em `memory-config.json` e autenticado
  no `modelRegistry` do Pi — sem modelo/auth, o job fica em retry com erro claro.
- Um job processa no máximo ~18K tokens de evidências por chamada; volumes
  maiores são rate-limited pelos gatilhos.
- Episódios `ignored` (sem evidência útil) nunca são reanalisados.
- Retry com delay exatamente 0 não agenda timer de espera (baixo impacto:
  o retry imediato é reprocessado pelo loop na prática).
