# ADR — Architecture Decision Records: pi-memory

## Contexto

pi-memory é uma extensão de memória persistente para o pi coding agent. O objetivo é que o agente retenha conhecimento através de sessões — preferências, decisões de design, padrões de projeto, correções aprendidas — sem depender de serviços externos ou databases separados.

Este documento registra as decisões arquiteturais para cada estágio do pipeline de memória: CAPTURE → EXTRACT → STORE → CONSOLIDATE → RETRIEVE → INJECT.

As decisões foram baseadas na análise de 8 sistemas de memória de agente em produção (AgentMemory, Hindsight, Mem0, Zep/Graphiti, Letta, pi-memctx, pi-memory/jayzeng, pi-agent-memory/claude-mem) e adaptadas ao ecossistema pi (extensões TypeScript, eventos de lifecycle, ferramentas built-in).

---

## ADR-001: CAPTURE — O que e quando capturar

### Decisão

**Capturar toda tool call em `tool_result` como "observação bruta" (raw observation), fire-and-forget, com TTL curto (7 dias).**

### Alternativas consideradas

| Alternativa | Vantagem | Desvantagem | Rejeitada porque |
|---|---|---|---|
| `turn_end` apenas | Contexto agregado do turno inteiro | Perde detalhes: qual tool, com quais args, qual resultado específico | Informação insuficiente para extração precisa de fatos |
| `message_end` em toda mensagem | Captura conversa completa | Ruído extremo — 95% do conteúdo não gera memória útil | Inviabiliza consolidação |
| `before_agent_start` apenas | Captura intenção do usuário | Não captura ações do agente nem resultados | Memória só saberia perguntas, não respostas |
| Hooks manuais (`memory_write`) | Controle total do usuário | Depende do usuário/agente lembrar de salvar | Amnésia parcial garantida |

### Decisão detalhada

**Evento primário:** `tool_result`
- Captura toda tool call completada: nome da tool, input resumido, outcome (success/error), preview do output
- Fire-and-forget: enfileira em buffer, não bloqueia o agente
- Filtro de trivialidade: ignora `read`, `ls`, `find` com resultados triviais (só captura se o agente AGIU ou descobriu algo)

**Evento secundário:** `turn_end`
- Agrega contexto do turno: assistant message + todos os tool results
- Usado para trigger de extração (só extrai fatos em turnos "ricos": com bash/edit/write)

**Evento de metadata:** `before_agent_start`
- Registra intenção do usuário (prompt), projeto, timestamp

**Evento de fecho:** `session_shutdown`
- Dispara flush do buffer de observações e sweep final de consolidação

### Raw observation schema

```typescript
interface RawObservation {
  id: string;                    // UUID
  sessionId: string;
  projectId: string;
  timestamp: number;
  type: "tool_result" | "user_prompt";
  toolName?: string;
  input?: Record<string, unknown>;
  outcome: "success" | "error";
  contentPreview: string;        // primeiros 2KB do output
  errorPreview?: string;         // primeiros 500B do stderr
  filePaths?: string[];          // arquivos afetados
  ttl: number;                   // timestamp de expiração (+7 dias)
}
```

### TTL reasoning

Observações brutas existem apenas como matéria-prima para extração. Após 7 dias sem gerar memória semântica, são descartadas. Memórias semânticas (output do EXTRACT) não têm TTL — decaem por confidence scoring.

---

## ADR-002: EXTRACT — Como transformar observações em conhecimento

### Decisão

**Pipeline de 3 níveis: Regex (N2, custo zero) → LLM barato (N3, background) → Entity Resolution + KG (N4, sob demanda).**

### Alternativas consideradas

| Alternativa | Vantagem | Desvantagem | Rejeitada porque |
|---|---|---|---|
| Apenas N2 (regex) | Custo zero, instantâneo | Só captura padrões conhecidos, perde 80% do valor | Não entende linguagem natural |
| Apenas N3 (LLM) | Maior cobertura, entende contexto | Custo de LLM call (~200-500 tokens) a cada extração | Sem otimização para padrões triviais |
| N4 (KG completo) desde o início | Máximo poder semântico | Complexidade de manutenção altíssima (ver ADR-002-N4 abaixo) | Custo de desenvolvimento proibitivo para v1 |

### Decisão detalhada

**Nível 2 — Regex (imediato, inline, custo zero):**

Roda diretamente no `tool_result` handler, SEMPRE. Extrai padrões óbvios:

| Padrão Regex | O que extrai | Exemplo |
|---|---|---|
| `npm (test\|run\|build).*→.*FAIL` | Test/build failure | "Test failure: auth.spec.ts" |
| `(installed\|added\|removed).*dependency` | Mudança de dependência | "Added dependency: zod@3.0.0" |
| `git (commit\|push\|merge\|rebase)` | Ação de versionamento | "Git commit: fix auth bug" |
| `Error:.*\n.*at .*\(.*:\d+:\d+\)` | Stack trace pattern | "Runtime error in src/auth.ts:42" |
| `(prefer\|use\|always\|never)\s+(\w+)` | Preferência declarada | "Prefere pnpm sobre npm" |

**Nível 3 — LLM barato (background, fire-and-forget, custo ~$0.0002/extração):**

Trigger: `turn_end` de turnos "ricos" (com bash/edit/write).
Modelo: gpt-4o-mini (ou configuração equivalente).
Prompt: "Extraia fatos atômicos e autocontidos desta interação."

Executa em worker separado (não bloqueia o agente). Timeout de 5s.

**Nível 4 — Entity Resolution + Knowledge Graph (futuro, feature flag):**

Implementado como módulo separado, ativado por configuração.
Ver ADR-002-N4 abaixo.

### ADR-002-N4: Complexidade do Knowledge Graph

O N4 não será implementado na v1 pelos seguintes motivos:

1. **Entity Resolution é o subproblema mais difícil.** Distinguir "Bob" de "Bob (backend)" como mesma pessoa requer contexto. Falsos positivos envenenam o grafo silenciosamente.

2. **Manutenção de grafo temporal é complexa.** Cada atualização precisa fechar `valid_until` da aresta anterior, propagar mudanças para dependentes, e resolver conflitos de ordenação (turno 30 processado antes do 25 por async).

3. **Relação custo/benefício.** N3 entrega ~80% do valor com ~20% da complexidade.

4. **O grafo pode ser adicionado depois.** A arquitetura de storage (ADR-003) suporta migração para grafo sem reescrever os outros estágios.

### Fluxo de extração

```
tool_result ──► N2 regex (inline, <1ms) ──► fatos extraídos → enfileira para store
                    │
                    └──► se pattern match, marca observação como "extraída"

turn_end ──► check: turno "rico"? (teve bash/edit/write)
                │
                ├── NÃO → skip
                │
                └── SIM → enfileira N3 LLM extraction (background, ~800ms)
                              │
                              └──► fatos extraídos → enfileira para store
```

---

## ADR-003: STORAGE — Onde e como persistir

### Decisão

**Arquitetura de 3 camadas: Hot (índice em RAM), Warm (SQLite FTS5), Cold (JSON em disco).**

### Alternativas consideradas

| Alternativa | Vantagem | Desvantagem | Rejeitada porque |
|---|---|---|---|
| JSON apenas (AgentMemory-style) | Zero deps, debug fácil | Sem FTS5, sem queries complexas, escala limitada | Busca lenta com >10K observações |
| Markdown apenas (pi-memory-style) | Legível, git-friendly | Precisa de indexador externo (qmd) | qmd é dependência extra |
| SQLite + FTS5 apenas | Bom meio-termo | Sem busca semântica (vetores) | Sem embeddings, perde queries por significado |
| PostgreSQL + pgvector (Hindsight-style) | Tudo em um, ACID | Docker obrigatório | Dependência externa pesada para extensão pi |
| ChromaDB separado (pi-agent-memory) | Vector search nativo | Serviço externo, 2 processos | Complexidade operacional |

### Decisão detalhada

```
┌─────────────────────────────────────────────────┐
│ HOT PATH  (latência: 1-50ms)                     │
│                                                   │
│ Índice em memória RAM reconstruído no             │
│ session_start. Contém:                            │
│   - Índice BM25 (lexical)                        │
│   - Índice vectorial (MinilM-L6-v2, 384 dims)    │
│                                                   │
│ USO: retrieval durante before_agent_start         │
│      queries da tool memory_search                │
│                                                   │
│ RECONSTRUÇÃO: a cada session_start, lê todas      │
│ as memórias do cold storage e reconstrói índice.  │
│ Tempo: ~1-3s para 10K memórias.                  │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ WARM PATH (latência: 10-200ms)                    │
│                                                   │
│ SQLite + FTS5 em disco. Persiste entre sessões.   │
│ Schema:                                           │
│   - memories (id, text, type, scope, tags, ...)   │
│   - memories_fts (FTS5 virtual table)             │
│   - observations (raw, com TTL)                   │
│                                                   │
│ USO: fallback quando índice RAM está frio         │
│      queries que precisam de SQL (filtros)        │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ COLD PATH (latência: 100ms-2s)                    │
│                                                   │
│ JSON em disco: ~/.pi/agent/memory/data/           │
│   - memories.json     (array de Memory)           │
│   - observations.json (array de RawObservation)   │
│                                                   │
│ USO: auditoria, debug, rebuild do índice          │
│      export, backup, portabilidade                │
│                                                   │
│ VANTAGEM: legível com qualquer editor,            │
│           versionável com git, diff amigável      │
└─────────────────────────────────────────────────┘
```

### Por que SQLite + FTS5 como warm layer

1. **FTS5 é nativo do SQLite.** Sem dependência extra. `better-sqlite3` já compila com FTS5 habilitado.
2. **BM25 built-in.** Função `bm25()` disponível diretamente nas queries.
3. **Stemming e unicode.** Tokenizer `porter unicode61` lida com português e inglês.
4. **Zero config.** Arquivo único. Sem processo separado.
5. **Migração futura para sqlite-vec.** Extensão sqlite-vec adiciona busca vetorial no mesmo DB.

### Por que índice em RAM como hot layer

1. **Latência.** 1-50ms vs 10-200ms do SQLite. Diferença perceptível no hot path.
2. **BM25 customizado.** Implementação própria permite tuning específico para memórias de código.
3. **Vector index.** Faiss ou LanceDB em WASM — sem dependência nativa.
4. **Reconstrução barata.** 10K memórias com embeddings de 384 dims = ~15MB. Reconstrói em <2s.

### Schema SQLite

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  embedding BLOB,            -- float32 array (384 dims)
  type TEXT NOT NULL,        -- 'preference' | 'decision' | 'lesson' | 'fact' | 'pattern'
  scope TEXT NOT NULL,       -- 'project' | 'user' | 'session' | 'global'
  tags TEXT,                 -- JSON array: ["#preference","#pnpm"]
  confidence REAL DEFAULT 0.5,
  timestamp INTEGER NOT NULL,
  last_accessed INTEGER,
  access_count INTEGER DEFAULT 0,
  source_ids TEXT,           -- JSON array de observation IDs
  superseded_by TEXT,
  pinned INTEGER DEFAULT 0,
  project_id TEXT NOT NULL,
  content_hash TEXT          -- SHA256 para dedup
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  type,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool_name TEXT,
  input_json TEXT,
  outcome TEXT NOT NULL,
  content_preview TEXT,
  error_preview TEXT,
  file_paths TEXT,           -- JSON array
  ttl INTEGER NOT NULL,      -- timestamp de expiração
  extracted INTEGER DEFAULT 0 -- N2 extraiu fatos?
);

CREATE INDEX IF NOT EXISTS idx_observations_ttl ON observations(ttl);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
```

---

## ADR-004: CONSOLIDATE — Como evitar memory rot

### Decisão

**Pipeline de 3 níveis: N1 (dedup imediato, custo zero) → N2 (sweep periódico, custo baixo) → N3 (dream manual, custo alto).**

### Alternativas consideradas

| Alternativa | Vantagem | Desvantagem | Rejeitada porque |
|---|---|---|---|
| Sem consolidação (append-only log) | Simples, zero complexidade | Degradação garantida com >1K obs | Não escala |
| Apenas N1 (dedup) | Cobre 60% dos casos com custo zero | Sem merge de paráfrases, sem decay, sem pruning | Memória ainda acumula lixo |
| Consolidação contínua (todo write) | Memória sempre limpa | Custo de LLM a cada write, latência no write | Write fica lento demais |
| Apenas N3 manual (/memory-dream) | Controle total do usuário | Usuário esquece, memória degrada entre dreams | Não é autossuficiente |

### Decisão detalhada

**Nível 1 — Imediato, custo zero (roda inline no write):**

Regra 1: **Dedup por hash de conteúdo.**
```
Nova observação chega → normaliza conteúdo → SHA256
  → Se hash já existe:
    - Incrementa access_count da memória existente
    - Atualiza last_accessed
    - Aumenta confidence (+0.05, cap 1.0)
    - NÃO cria nova memória
  → Se hash não existe: cria nova
```

Regra 2: **Último fato vence por chave composta.**
```
Chave = type + scope + tags (normalizadas e ordenadas)
  → Se chave já existe:
    - Detecta contradição via regex patterns
      ("não usa mais", "mudou para", "agora prefere", "substitui por")
    - Se contradição: marca antiga como superseded_by = novo_id, cria nova
    - Se não contradição: atualiza texto, incrementa confidence
  → Se chave não existe: cria nova
```

**Nível 2 — Background sweep (roda a cada 50 observações ou 30 min):**

```
1. SELECT observações NÃO extraídas (extracted=0) dos últimos N minutos
2. Agrupa por projeto + tool_name
3. Para cada grupo com ≥3 observações:
   a. LLM barato (gpt-4o-mini) extrai 1-3 fatos semânticos do grupo
   b. Insere memórias extraídas (passam pelo N1)
   c. Marca observações como extracted=1
4. Decay:
   a. Memórias com last_accessed > 7 dias: confidence *= 0.9
   b. Memórias com confidence < 0.2: candidatas a pruning
   c. Memórias pinadas (pinned=1): imunes a decay
5. Pruning:
   a. DELETE memórias com confidence < 0.1 E last_accessed > 30 dias
   b. Log de auditoria para cada deleção
6. Limpeza de TTL:
   a. DELETE observações com ttl < now()
```

**Nível 3 — Dream manual (comando /memory-dream):**

```
1. Usuário invoca /memory-dream (ou configuração automática)
2. Busca todas as memórias do projeto
3. Agrupa por similaridade (embedding cosine > 0.85)
4. Para cada grupo com ≥2 memórias:
   a. LLM potente (gpt-4o ou Claude) analisa:
      - São duplicatas? → merge em uma consolidada
      - São contraditórias? → resolve (mais recente vence por padrão)
      - São complementares? → mantém ambas, adiciona cross-reference
   b. Gera relatório: o que foi merged, resolvido, mantido
5. Usuário revisa e confirma (ou rejeita) cada ação
6. Memórias pinadas são intocáveis pelo dream
```

### Por que sweep a cada 50 obs ou 30 min

- **50 observações:** Em uso intenso (~10 tool calls/turno, ~5 turnos), sweep roda a cada ~5 turnos. Frequente o suficiente para evitar acúmulo, raro o suficiente para não gerar custo excessivo de LLM.
- **30 minutos:** Fallback para uso leve (lendo documentação por 2h). Sweep roda mesmo sem volume.
- **Execução em background:** worker thread ou microtask. Nunca bloqueia o agente.

---

## ADR-005: RETRIEVE — Como achar conhecimento relevante

### Decisão

**Multi-strategy retrieval: BM25 (lexical) + Vector (semântico) + Graph (relacional, futuro) → RRF fusion → Cross-encoder reranker.**

### Alternativas consideradas

| Alternativa | Vantagem | Desvantagem | Rejeitada porque |
|---|---|---|---|
| Apenas BM25/FTS5 | Rápido (~10ms), preciso para termos exatos | Não entende sinônimos, paráfrases, conceitos | "Deploy" ≠ "publicar". Perde contexto semântico |
| Apenas vector search | Entende significado, sinônimos | Pode retornar semanticamente similar mas factualmente errado | Negação ("NUNCA use X") tem embedding similar a "use X" |
| BM25 + Vector sem reranker | Cobre lexical e semântico | Sem reranker, ranking final pode ser pior que qualquer estratégia isolada | Resultados contraditórios competem sem desempate |
| LLM como retrieval (sem índice) | Máxima compreensão | 2-30s de latência, custo proibitivo em escala | Impraticável para hot path |

### Decisão detalhada

**Pipeline de retrieval:**

```
query: "como fazer deploy do payment-api?"

FASE 1: PARALELA (3 estratégias rodam simultaneamente)
┌──────────────┐  ┌──────────────────┐  ┌─────────────────┐
│ BM25 (FTS5)  │  │ Vector (faiss)   │  │ Graph (futuro)  │
│              │  │                  │  │                 │
│ "deploy"+"   │  │ embed(query)→    │  │ payment-api →   │
│ payment"+"   │  │ cosine similarity│  │ DEPLOYED_VIA →  │
│ api"         │  │ top-20           │  │ ArgoCD          │
│              │  │                  │  │                 │
│ top-20       │  │ top-20           │  │ top-10          │
└──────┬───────┘  └────────┬─────────┘  └────────┬────────┘
       │                   │                     │
       └───────────────────┼─────────────────────┘
                           │
                           ▼
FASE 2: RECIPROCAL RANK FUSION (RRF)
       │
       │ score_final = Σ 1/(k + rank_i) para cada estratégia i
       │ k = 60 (constante de suavização)
       │
       ▼
       top-20 combinado

FASE 3: CROSS-ENCODER RERANKER
       │
       │ Para cada doc no top-20:
       │   cross-encoder(query, doc) → score de relevância real
       │
       ▼
       top-10 rerankeado → resultado final
```

**BM25 via SQLite FTS5:**
```sql
SELECT m.*, bm25(memories_fts) as bm25_score
FROM memories m
JOIN memories_fts ON m.rowid = memories_fts.rowid
WHERE memories_fts MATCH :query
  AND m.project_id = :project_id
ORDER BY bm25_score
LIMIT 20;
```

**Vector search via faiss (em RAM):**
- Modelo de embedding: `all-MiniLM-L6-v2` (384 dimensões, 80MB, roda local)
- Índice faiss: `IndexFlatIP` (inner product, equivalente a cosine similarity com vetores normalizados)
- Query: embed(query) → search(index, k=20)

**Reranker:**
- Modelo: `ms-marco-MiniLM-L-6-v2` (80MB, cross-encoder)
- Entrada: par (query, document_text)
- Saída: score de relevância [0, 1]
- Latência: ~5ms por par. Para 20 docs: ~100ms total.

### Latência alvo

| Fase | Latência |
|---|---|
| BM25 (FTS5) | 10-30ms |
| Vector (faiss) | 5-15ms |
| RRF merge | <1ms |
| Reranker (20 docs) | ~100ms |
| **Total** | **~100-150ms** |

### Fallback quando índice RAM está frio

Se o índice em RAM não foi reconstruído ainda (ex: acabou de iniciar):
1. Usa FTS5 como fonte primária (warm path)
2. Se configurado, usa qmd como índice externo
3. Retorna resultados FTS5 diretamente (sem vector, sem reranker)
4. Reconstrói índice RAM em background

---

## ADR-006: INJECT — Como entregar memória ao agente

### Decisão

**KV Cache-Stable Snapshot (injeção automática) + Memory Gateway (judge de suficiência) + `memory_search` tool (agência do modelo).**

### Alternativas consideradas

| Alternativa | Vantagem | Desvantagem | Rejeitada porque |
|---|---|---|---|
| Injeção em todo `context` (não `before_agent_start`) | Modifica mensagens individuais | Muito tarde — modelo já começou sem contexto | Memória deve chegar ANTES do raciocínio |
| Injeção dinâmica a cada turno (sem snapshot) | Contexto sempre atualizado | Invalida KV cache a cada turno, custo 2-10x maior | Custo proibitivo em providers com cache pricing |
| Apenas tool `memory_search` (sem injeção automática) | Modelo decide quando buscar | Modelo não sabe que não sabe — omite busca | Agente fica amnésico para contexto ambiental |
| Memory Gateway bloqueando tool calls | Máxima eficiência | Risco de alucinação se memória estiver stale | Precisa de judge muito confiável |

### Decisão detalhada

#### Componente 1: KV Cache-Stable Snapshot

**Mecanismo:** O bloco de memória injetado no system prompt é congelado e só muda em checkpoints estratégicos.

```
Checkpoints que invalidam o snapshot:
  - session_start          → novo contexto, rebuild obrigatório
  - session_before_compact  → handoff capturado, snapshot rebuild
  - memory_write (long_term) → mudança intencional, usuário espera ver refletida
  - day rollover            → daily log mudou (data nos headers)

O que NÃO invalida o snapshot:
  - memory_write (daily)    → conteúdo visível via tool call args
  - scratchpad write        → idem
  - memory_search call      → busca explícita, não afeta injeção
```

**Formato do bloco injetado (ordem de prioridade):**

```
## Scratchpad (até 2KB)
[ ] Fix auth bug
[ ] Review PR #42

## Today — 2026-07-26 (até 3KB, tail)
...últimas 15 linhas do daily log de hoje...

## Persistent Memory (até 4KB, middle-truncated)
- [preference] Usa pnpm em todos os projetos
- [decision] Payment API segue hexagonal architecture
- [pattern] Testes usam vitest com @test/helpers

## Yesterday — 2026-07-25 (até 3KB, tail — menor prioridade)
...últimas 15 linhas do daily log de ontem...
```

**Cap total:** 16KB (~4K tokens).

#### Componente 2: Memory Gateway (Judge)

**Mecanismo:** Antes de cada LLM call, avalia se as memórias recuperadas são suficientes para responder o prompt sem inspeção do repositório.

```
User prompt
    │
    ▼
1. RETRIEVE: busca top-10 memórias com o prompt como query
    │
    ▼
2. JUDGE: avalia suficiência
    │
    ├── confidence > 0.85 → "KNOWN ANSWER"
    │   Injeta resposta direta, instrui: "DO NOT re-explore"
    │
    ├── confidence 0.6-0.85 → "PRIOR KNOWLEDGE"
    │   Injeta contexto, instrui: "Verify with repo if unsure"
    │
    └── confidence < 0.6 → "NO MEMORY"
        Deixa LLM explorar normalmente (sem injeção)
```

**Implementação do Judge:**

Heurístico (v1, custo zero):
- Top score > 0.9 E ≥3 resultados → HIGH
- Top score > 0.8 → MEDIUM
- Top score < 0.8 → LOW

Com metadata (v2):
- Penaliza por idade: >7 dias desde last_accessed → confiança -30%
- Penaliza por contradições detectadas nos top-5 → confiança -50%

LLM-based (v3):
- gpt-4o-mini avalia: "Can the query be fully answered from these memories?"

#### Componente 3: `memory_search` Tool

```typescript
tool: memory_search
  description: "Search persistent memory across sessions. Use when you need
                context about project patterns, past decisions, or user preferences
                that wasn't automatically injected."
  parameters:
    query: string
    type: "preference" | "decision" | "lesson" | "fact" | "pattern" (optional)
    scope: "project" | "user" | "global" (optional, default: "project")
  returns: array de Memory com score, texto e metadata
```

A tool dá ao modelo **agência**: buscar ativamente quando o contexto injetado não é suficiente.

---

## ADR-007: Estrutura de Arquivos da Extensão

```
~/.pi/agent/extensions/pi-memory/
├── index.ts                  # Factory principal, registro de events/tools/commands
├── config.ts                 # LoadConfig (global + project-local)
├── types.ts                  # Tipos (Memory, Observation, Config, etc.)
├── package.json              # Dependências (better-sqlite3, @xenova/transformers)
├── impl/                     # Documentação de arquitetura
│   ├── ADR.md                # Este documento
│   └── dev/
│       ├── development.md    # Plano sequencial de implementação
│       ├── CAPTURE.md        # Detalhes de implementação: captura
│       ├── EXTRACT.md        # Detalhes de implementação: extração
│       ├── STORAGE.md        # Detalhes de implementação: armazenamento
│       ├── CONSOLIDATE.md    # Detalhes de implementação: consolidação
│       ├── RETRIEVE.md       # Detalhes de implementação: recuperação
│       └── INJECT.md         # Detalhes de implementação: injeção
├── storage/
│   ├── index.ts              # Interface IStorage
│   ├── sqlite-store.ts       # Implementação SQLite + FTS5 (warm)
│   ├── ram-index.ts          # Índice em RAM (hot): BM25 + faiss
│   └── json-store.ts         # Cold storage: JSON em disco
├── capture/
│   ├── hooks.ts              # handlers de tool_result, turn_end, etc.
│   └── buffer.ts             # Observation buffer (enfileiramento)
├── extract/
│   ├── regex-extractor.ts    # N2: pattern matching
│   ├── llm-extractor.ts      # N3: LLM-based extraction
│   └── kg-extractor.ts       # N4: Knowledge Graph (futuro)
├── retrieve/
│   ├── bm25.ts               # BM25 via FTS5
│   ├── vector.ts             # Vector search via faiss
│   ├── hybrid.ts             # RRF fusion
│   └── reranker.ts           # Cross-encoder reranker
├── consolidate/
│   ├── dedup.ts              # N1: dedup por hash + last-fact-wins
│   ├── sweep.ts              # N2: background sweep
│   └── dream.ts              # N3: /memory-dream command
├── inject/
│   ├── snapshot.ts           # KV cache-stable snapshot builder
│   ├── gateway.ts            # Memory Gateway judge
│   └── context-builder.ts    # Formata bloco de contexto
├── tools/
│   ├── memory-search.ts      # Tool: memory_search
│   ├── memory-write.ts       # Tool: memory_write
│   ├── memory-status.ts      # Tool: memory_status
│   └── memory-dream.ts       # Command: /memory-dream
└── utils/
    ├── hash.ts               # SHA256, normalização
    ├── text.ts               # Truncate, middle-truncate, tail
    ├── embedding.ts          # Embedding via transformers.js
    └── timer.ts              # Debounce, interval helpers
```

---

## ADR-008: Dependências Externas

| Dependência | Propósito | Tamanho | Justificativa |
|---|---|---|---|
| `better-sqlite3` | SQLite + FTS5 | ~5MB (nativo) | Única dep nativa. Essencial para warm storage |
| `@xenova/transformers` | Embeddings + reranker | ~80MB (download) | Roda localmente, sem API key. MiniLM models |
| `faiss-node` | Vector index | ~3MB (nativo) | Alternativa: usar sqlite-vec no futuro |
| `typebox` | Schema validation | Peer dep do pi | Já incluso no ecossistema pi |

**Total:** ~88MB (com modelos de embedding). Sem API keys necessárias. 100% local.

---

## ADR-009: Métricas e Observabilidade

### Métricas expostas via `memory_status` tool

```
🧠 pi-memory v1.0.0
   Project: my-project
   Hot index: ✓ loaded (1,234 memories, 42MB RAM)
   Warm DB:   ✓ SQLite (/home/.../memory.db), 2.3MB
   Cold store: ✓ JSON (/home/.../memory/data/)

   Memories:  1,234 total
     By type:    preference: 156 | decision: 89 | lesson: 234 | fact: 567 | pattern: 188
     By scope:   project: 1,100 | user: 98 | global: 36
     Avg confidence: 0.73
     Pinned: 12

   Observations: 4,567 total
     Pending extraction: 23
     Expired: 1,200 (cleanup pending)

   Operations (since session start):
     Captures:  156
     Extractions (N2): 89
     Extractions (N3): 12
     Consolidations (N2 sweep): 3
     Retrievals: 234 (avg: 45ms)
     Injections: 156

   KV Cache: stable (snapshot age: 12min, 3 turns since rebuild)
   Gateway:  active (judge: heuristic)
     Decisions: HIGH=45, MEDIUM=78, LOW=33
```

---

## ADR-010: Roadmap e Fases

### Fase 1: Fundação (MVP) — 2-3 semanas
- [x] CAPTURE: `tool_result` handler + buffer
- [x] STORAGE: SQLite + FTS5 (warm) + JSON (cold)
- [x] CONSOLIDATE: N1 (dedup + last-fact-wins)
- [x] RETRIEVE: BM25 via FTS5 apenas
- [x] INJECT: `before_agent_start` simples + `memory_search` tool
- [x] Tools: `memory_search`, `memory_write`, `memory_status`

### Fase 2: Inteligência — +1-2 semanas
- [ ] EXTRACT: N2 (regex patterns)
- [ ] EXTRACT: N3 (LLM background extraction)
- [ ] CONSOLIDATE: N2 (background sweep)
- [ ] RETRIEVE: Vector search (faiss)
- [ ] RETRIEVE: RRF fusion + reranker
- [ ] INJECT: KV cache-stable snapshot

### Fase 3: Robustez — +1-2 semanas
- [ ] STORAGE: Hot index em RAM
- [ ] INJECT: Memory Gateway com judge heurístico
- [ ] CONSOLIDATE: N3 (`/memory-dream` command)
- [ ] CONSOLIDATE: Decay + pruning automático
- [ ] EXTRACT: N4 básico (entity resolution sem temporal)

### Fase 4: Produto — +2-4 semanas
- [ ] EXTRACT: N4 completo (Knowledge Graph temporal)
- [ ] RETRIEVE: Graph traversal
- [ ] INJECT: Memory Gateway com judge LLM-based
- [ ] Markdown export (MEMORY.md + daily/ — compatível com pi-memory)
- [ ] Mesh federation (sync entre múltiplos agentes, futuro distante)
