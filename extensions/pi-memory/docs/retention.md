# Retenção por inatividade (decay automático)

Memórias que nunca são usadas perdem relevância operacional, mas **não** perdem
certeza factual. Este documento define a arquitetura do módulo de retenção que
decai memórias por desuso sem tocar na semântica de `confidence`.

## Princípios

1. **`confidence` ≠ relevância.** `confidence` mede certeza factual (decai por
   contradição/obsolescência via `memory_decay` manual). Inatividade não deve
   rebaixar a confiança nem mover memórias para `.supersedes/` — conteúdo
   factualmente correto continua correto mesmo se nunca foi consultado.
2. **`retention_score` mede relevância operacional.** Decai por falta de uso e
   reseta ao usar. Usado como critério secundário de ordenação — nunca domina
   a relevância lexical (BM25) nem a confiança.
3. **Markdown continua canônico.** Nenhuma escrita no Markdown por causa de
   uso/desuso (isso geraria escrita por leitura, conflito entre sessões e
   poluição de `.history/`). A atividade vive em banco separado.
4. **Tolerante a falha.** Banco de retenção indisponível não quebra busca,
   salvar ou pipeline — degrada (score padrão, sem registro) e segue.

## Visão geral

```
memory_search ──> resultados ──> recordAccess(path) ──> .retention.sqlite
                                                         ├─ last_used_at
                                                         ├─ use_count
                                                         └─ retention_score
RetentionScheduler ── sweep periódico (idempotente)
   ├─ reconcile(arquivos ativos ↔ banco)
   ├─ recompute(scores por fórmula, pulando protected)
   └─ apply → memory_documents.retention_score (ranking)
```

## Persistência

### Frontmatter v3

| Campo | Valor | Descrição |
|---|---|---|
| `memory_id` | uuid | Identidade estável da memória, independente de path/tipo/contexto. Gerado na migração v2→v3 e em toda criação nova. |
| `retention_policy` | `normal` \| `protected` | `protected` nunca decai automaticamente. Default por tipo: `_rules` → `protected`; demais → `normal`. Preservado em consolidações. |

`last_used_at` **não** vai para o frontmatter — dado de atividade, não de
conteúdo.

### `.retention.sqlite` (banco derivado, reconstruível)

```sql
CREATE TABLE memory_activity (
  memory_id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  project_id TEXT,
  type TEXT NOT NULL,
  context TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,   -- criação (ou primeiro reconcile)
  last_used_at TEXT,             -- null = nunca usada
  use_count INTEGER NOT NULL DEFAULT 0,
  retention_score REAL NOT NULL DEFAULT 1.0,
  last_decay_at TEXT,
  policy TEXT NOT NULL DEFAULT 'normal',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE retention_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Banco apagado → reconstrói no próximo `session_start` com scores 1.0
(reconcile + sweep). Nenhum dado canônico é perdido.

## Contagem de uso

Conta como uso: resultado retornado por `memory_search` (engine SQLite **ou**
fallback rg) ou leitura realizada por `memory_read`. Não conta: listagem no system prompt, busca vazia, busca interna da extração, rebuild/sync do índice, `memory_status`, `memory_decay`.

`recordAccess` é por path, deduplicado por chamada de busca, e imediato:

```text
last_used_at = agora
use_count   += 1
retention_score = 1.0
```

Também atualiza `memory_documents.retention_score` (via `MemoryIndex`) para a
sessão atual enxergar o bump sem esperar o sweep.

## Algoritmo

```ts
RETENTION_GRACE_DAYS      = 30    // sem decay antes disso
RETENTION_HALF_LIFE_DAYS  = 90    // score cai pela metade a cada 90d de desuso
RETENTION_MIN_SCORE       = 0.05  // piso (evita score ~0 invisível de vez)

idleDays  = (nunca usada) ? hoje - first_seen_at : hoje - last_used_at
decayDays = max(0, idleDays - GRACE_DAYS)
score     = 2 ** (-decayDays / HALF_LIFE_DAYS)
score     = max(score, MIN_SCORE)
```

Exemplos (sem uso): 30d → 1.00 · 75d → ~0.71 · 120d → ~0.50 · 210d → ~0.25.

Memórias `protected` não são recalculadas (score congelado em 1.0).

## Scheduler

`RetentionScheduler` é **independente** do `PipelineWorker` (extração LLM):

- `session_start`: abre `.retention.sqlite`, reconcile, sweep inicial (se
  devido) e agenda o próximo `setTimeout`.
- `session_shutdown`: cancela o timer e fecha o banco.
- `setProject` no `session_tree` (sweep processa global + projeto ativo).
- Idempotente: recalcular duas vezes não aplica decay duplicado (fórmula
  pura sobre timestamps).
- Concorrência entre sessões: WAL + `busy_timeout`; escritas upsert/recompute
  são comutativas.

O sweep **nunca** altera Markdown, nunca move para `.supersedes/` e nunca
decreta confiança.

## Ranking

`memory_documents` ganha `retention_score REAL NOT NULL DEFAULT 1.0`
(schema v3). Ordenação da busca FTS5:

```text
BM25 (relevância lexical) → confidence DESC → retention_score DESC → updated DESC → path
```

Memória antiga continua encontrável; apenas perde prioridade entre resultados
de relevância/confiança semelhantes. Sem exclusão automática da busca na v1.

## Tools e observabilidade

- `memory_search` e `memory_read` — registram acesso (fire-and-forget; falha degrada).
- `memory_status` — seção `retention:` (enabled, last_sweep_at, tracked,
  never_used, protected, low_retention).
- **nova** `memory_retention` — ações `status` / `preview` (dry-run sem
  escrita) / `run` (força sweep). `preview` valida política antes de ativar.

## Rollout

- Feature flag `RETENTION_ENABLED = false` (default desativado).
- Migração v2→v3 idempotente: atribui `memory_id` e `retention_policy`
  apenas a arquivos sem esses campos; não altera `updated`.
- Ativar após validar `memory_retention preview` + métricas em
  `memory_status`.

## Testes

- Algoritmo: grace, meia-vida, nunca usada, protected, piso, relógio.
- Store: upsert/reconcile/record/sweep idempotente, path renomeado,
  desativação, banco apagado (reconstrução).
- Scheduler: start/stop, intervalo, lote, projeto trocado.
- Busca: SQLite e rg registram uso; vazia não registra; falha não quebra.
- Não-regressão: `memory_decay` continua só confiança; sweep não altera
  Markdown; migração v2→v3 preserva `updated` e `confidence`.
