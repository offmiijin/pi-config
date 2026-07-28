# pi-memory

Memória persistente entre sessões para o pi coding agent.

Retém conhecimento através de sessões — preferências, decisões de design, padrões de projeto, lições aprendidas, fatos objetivos — sem depender de API externa obrigatória. 100% local no modo base.

## Instalação

```bash
# A extensão já está em ~/.pi/agent/extensions/pi-memory/, carregada automaticamente.

# Para desabilitar:
pi --no-memory
```

## Pipeline (6 estágios)

```
CAPTURE → EXTRACT → STORE → CONSOLIDATE → RETRIEVE → INJECT
```

| Estágio | O que faz | Status |
|---|---|---|
| **CAPTURE** | Toda tool call gera observação bruta (fire-and-forget, TTL 7 dias). Buffer em memória com flush em lote (periódico + ao atingir maxSize). | ✅ |
| **EXTRACT N2** | Regex patterns inline (~1ms) extraem fatos de tool results — test failures, dep changes, git actions, runtime errors, file ops, preference declarations, config changes. Custo zero. | ✅ |
| **EXTRACT N3** | LLM barato (default: `deepseek/deepseek-v4-flash` via OpenRouter) processa observações em background após turnos "ricos" (bash/edit/write). Prompt estruturado, parsing multi-formato (JSON direto, code block, inline array). Retry automático (3 tentativas). | ✅ (opt-in) |
| **STORE** | SQLite + FTS5 (warm) + JSON em disco (cold/auditoria). WAL mode. Triggers FTS5 mantêm índice de texto sincronizado automaticamente. | ✅ |
| **CONSOLIDATE N1** | Dedup por hash SHA256 + último fato vence por chave composta (type+scope+tags). Detecção de contradição via 13 patterns regex. Reforço incremental de confidence (+0.05 por reforço, cap 1.0). | ✅ |
| **CONSOLIDATE N2** | Sweep periódico (default: 30min). Agrupa observações pendentes por tool_name, extrai por grupo, aplica decay de confidence, pruning de memórias obsoletas, limpeza de TTL. | ✅ |
| **RETRIEVE** | BM25 via FTS5 (prefix matching, porter stemmer, unicode tokenizer). Normalização min-max 0-1. | ✅ |
| **RETRIEVE VECTOR** | Embeddings `all-MiniLM-L6-v2` (384 dims) via @xenova/transformers (local, ~80MB). Fallback API via OpenRouter. Índice em RAM com dot product (brute force, <15ms até 10K memórias). Backfill automático de embeddings ausentes. | ✅ (opt-in) |
| **RETRIEVE HYBRID** | BM25 + Vector → RRF fusion (k=60) → Cross-encoder reranker (`ms-marco-MiniLM-L-6-v2` local ou `cohere/rerank-4-pro` via API). Graceful degradation em qualquer componente ausente. | ✅ (opt-in) |
| **INJECT** | Bloco `## Persistent Memory` injetado via `before_agent_start`. Cache snapshot estável (ADR-006): bloco congelado entre checkpoints. Middle-truncation quando excede cap. Filtro de prompts triviais (continue, ok, etc). Day rollover força rebuild. | ✅ |

## Arquitetura de Storage (3 camadas)

```
┌─────────────────────────────────────────┐
│ HOT PATH  (latência: 1-50ms)            │
│ Índice em RAM — VectorRetriever dot     │
│ product + CacheStableInjector snapshot  │
├─────────────────────────────────────────┤
│ WARM PATH (latência: 10-200ms)          │
│ SQLite + FTS5 (bun:sqlite, WAL mode)    │
│ Triggers sincronizam FTS automaticamente│
├─────────────────────────────────────────┤
│ COLD PATH (latência: 100ms-2s)          │
│ JSON em disco (auditoria/debug/backup)  │
│ ~/.pi/agent/memory/data/                │
│ Atomic write via tmp + rename           │
└─────────────────────────────────────────┘
```

## Tools

| Tool | Descrição |
|---|---|
| `memory_search` | Busca memórias por texto. Busca híbrida (BM25 + vector + reranker se disponível). Filtros por type (preference/decision/lesson/fact/pattern) e scope (project/user/session/global). Exibe score e strategy (bm25/vector/hybrid). |
| `memory_write` | Salva preferência, decisão, padrão, fato ou lição. Pipeline N1 automático: dedup por hash, reforço de confidence, último fato vence com detecção de contradição. Gera embedding em background. Invalida cache snapshot. |
| `memory_status` | Estatísticas: total de memórias ativas/superseded, breakdown por tipo/scope, confidence média, pinned, observações pendentes de extração. |

## Tipos de Memória

| Tipo | Uso | Exemplo |
|---|---|---|
| `preference` | Preferência do usuário/time | `"Prefere pnpm em vez de npm"` |
| `decision` | Decisão de arquitetura/design | `"Payment API segue hexagonal architecture"` |
| `fact` | Fato objetivo sobre o projeto | `"CI/CD usa GitHub Actions com deploy no ECS"` |
| `pattern` | Padrão de código/projeto recorrente | `"Testes usam describe/it/expect do vitest"` |
| `lesson` | Lição aprendida com erro/acerto | `"Timeout do OAuth era 5min, não 30s — causava 401"` |

## Escopos

| Escopo | Abrangência |
|---|---|
| `project` | Específico do projeto atual (hash do diretório → project ID) |
| `user` | Preferências pessoais do usuário (cross-projeto) |
| `session` | Apenas para a sessão atual |
| `global` | Aplicável a todos os projetos/usuários |

## Configuração

### Global (`~/.pi/agent/memory/config.json`)

```json
{
  "disabled": false,
  "observation_ttl_ms": 604800000,
  "buffer_max_size": 100,
  "buffer_flush_interval_ms": 30000,
  "max_injected_memories": 5,
  "max_injection_bytes": 4096,
  "injection_confidence_threshold": 0.6,
  "extraction_level": "regex",
  "llm_extraction": {
    "enabled": false,
    "model": "deepseek/deepseek-v4-flash",
    "timeout_ms": 5000,
    "sweep_observation_threshold": 10,
    "sweep_interval_ms": 30000
  },
  "consolidation": {
    "dedup_enabled": true,
    "decay_enabled": false,
    "decay_days": 7,
    "decay_factor": 0.9,
    "pruning_confidence_threshold": 0.1,
    "pruning_age_days": 30
  },
  "retrieval": {
    "bm25_enabled": true,
    "vector_enabled": false,
    "hybrid_enabled": false,
    "reranker_enabled": false,
    "default_top_k": 10
  }
}
```

### Projeto (`.pi/memory.json`)

Mesmo formato — sobrescreve campos do global via deep merge.

### Ativação dinâmica

- **Vector search**: set `retrieval.vector_enabled: true`. Requer `@xenova/transformers` ou `OPENROUTER_API_KEY`.
- **LLM extraction N3**: set `extraction_level: "llm"` e `OPENROUTER_API_KEY`.
- **Reranker**: set `retrieval.reranker_enabled: true`. Usa modelo local ou API.
- **Decay/pruning**: set `consolidation.decay_enabled` e `pruning_enabled` (via SweepConsolidator config).

## Extração N2 — Regex Patterns (18 patterns)

Roda inline no `tool_result` handler, custo <1ms. Categorias:

| Categoria | Patterns | Confidence |
|---|---|---|
| Test/Build Failures | `test_failure`, `build_failure`, `lint_error` | 0.65–0.70 |
| Dependency Changes | `dependency_added/removed/updated` | 0.75 |
| Git Actions | `git_commit`, `git_action_generic` | 0.85–0.90 |
| Runtime Errors | `stack_trace`, `file_location_error`, `bash_error` | 0.75–0.80 |
| Preferences | `preference_explicit`, `always_never_rule`, `uses_tool` | 0.55–0.60 |
| File Operations | `file_created/deleted/modified` | 0.70 |
| Configuration | `config_change` | 0.65 |

## Extração N3 — LLM (opt-in)

Extrai fatos semânticos via API OpenRouter (OpenAI-compatível). Prompt estruturado com regras de extração, examples, validação de saída.

Fluxo:
1. Turnos ricos (bash/edit/write) disparam `turn_end` → flush buffer → coleta observações pendentes → enfileira no LlmExtractor
2. Ao atingir batchSize (10) ou maxWaitMs (30s), chama LLM
3. Resposta parseada: JSON direto → code block → array inline
4. Cada fato passa pelo pipeline N1 (dedup + last-fact-wins)
5. Observações marcadas como extraídas; retry 3x em falha

Custo estimado: ~$0.0002/fato (deepseek-v4-flash via OpenRouter).

## Consolidação N1 — Pipeline (automática em toda escrita)

### 1. Dedup por hash

```
Nova memória → normalizeContent() → SHA256
  → Se hash existe e não superseded: reforça existente (+confidence, +access_count)
  → Se não: cria nova
```

A normalização remove UUIDs, timestamps ISO/unix, paths absolutos e colapsa whitespace antes do hash — garante que mesmo textos com dados voláteis diferentes sejam dedupados.

### 2. Último fato vence

```
Chave = type + scope + tags (normalizadas e ordenadas)
  → Se chave existe ativa e NOVA contradiz EXISTENTE (isContradiction):
    Marca antiga como superseded, cria nova
  → Se chave existe ativa e NÃO contradiz:
    Atualiza texto e confidence da existente
```

### Detecção de contradição

13 patterns regex em PT-BR + EN:
- `"não usa mais"`, `"parou de usar"`
- `"mudou para"`, `"alterado para"`, `"migrou para"`
- `"agora prefere"`, `"agora usa"`, `"substituído por"`
- `"em vez de"`, `"ao invés de"`, `"no lugar de"`
- `"descontinuado"`, `"deprecated"`, `"obsoleto"`
- `"nunca use"`, `"evite usar"`
- `"antes usava X, agora Y"` (pattern composto)
- `"removido/removida/deletado/apagado"` + artigo

## Consolidação N2 — Sweep (background)

Agendador periódico que:
1. Agrupa observações pendentes por tool_name
2. Dispara extração N3 por grupos ≥ 3 observações
3. Aplica decay de confidence em memórias não acessadas há decayDays
4. Remove (pruning) memórias com confidence < threshold E não acessadas há pruningAgeDays
5. Limpa observações com TTL expirado

## Retrieval Híbrido

Pipeline completo (Fase 2.5):

```
[query] → BM25 (FTS5) ─────────────────┐
         → Vector (dot product RAM) ──→ RRF (k=60) → Reranker → top-K
                                        (cross-encoder)
```

- **BM25**: sempre ativo, via SQLite FTS5 com prefix matching e porter stemmer
- **Vector**: opt-in (`retrieval.vector_enabled`), modelo all-MiniLM-L6-v2 local ou API fallback
- **RRF**: Reciprocal Rank Fusion (k=60), Cormack et al. SIGIR 2009. Fusiona BM25 + Vector sem treinamento
- **Reranker**: cross-encoder local ms-marco-MiniLM-L-6-v2 ou cohere/rerank-4-pro via API. Aplica no top-20 do RRF

Graceful degradation: qualquer componente ausente, o pipeline continua com os disponíveis.

## Injeção — Cache Snapshot (ADR-006, Fase 2.6)

O bloco de memória injetado no system prompt é **congelado** entre checkpoints para preservar o KV cache do provider.

### Gatilhos de rebuild

| Evento | Rebuild? |
|---|---|
| `session_start` | ✅ Sempre |
| `session_before_compact` | ✅ Sempre (handoff capturado) |
| `memory_write` | ✅ Sempre (mudança intencional) |
| Day rollover | ✅ Data do header mudou |
| `memory_search` | ❌ Busca explícita, não afeta injeção |
| Tool results | ❌ Captura não muda o que é injetado |

### Formato do bloco

```
## Persistent Memory
- [preference] Prefere pnpm
- [decision] API hexagonal com casos de uso
- [lesson] Timeout OAuth era 5min, não 30s
```

Sessões customizáveis via `setSection()` (scratchpad, daily log, yesterday). Middle-truncation: remove bullets do meio se excede cap, preservando top e bottom relevância.

## Filesystem

```
~/.pi/agent/memory/
├── config.json              # Configuração global
├── <project-id>.db          # SQLite + FTS5 (warm storage, WAL mode)
├── <project-id>.db-shm      # WAL shared memory
├── <project-id>.db-wal      # WAL write-ahead log
└── data/
    ├── memories.json        # Cold storage: array serializado de Memory
    └── observations.json    # Cold storage: array serializado de RawObservation
```

Projeto ID é hash do diretório (8 chars hex, estável por diretório).

## Comandos e Flags

| Comando/Flag | Descrição |
|---|---|
| `pi --no-memory` | Desabilita memória para esta sessão |
| `/skill:pi-memory` | Carrega skill com guia de uso das tools |

## Dependências

- **Runtime**: Bun (`bun:sqlite`) — nativo, zero deps externas
- **Opcional (embedding local)**: `@xenova/transformers` — WASM/ONNX, ~80MB, modelo all-MiniLM-L6-v2
- **Opcional (LLM extraction + reranker API)**: `OPENROUTER_API_KEY` env var
- **Sem APIs externas obrigatórias** — 100% funcional no modo base (BM25-only, regex extraction)

## Estrutura do Código

```
extensions/pi-memory/
├── index.ts              # Entry point: lifecycle hooks, tool registration, init orchestration
├── config.ts             # Config loader: global + project-local + env merge
├── types.ts              # Tipos: Memory, RawObservation, ExtractedFact, Config, Stats, RetrievalResult
│
├── capture/
│   ├── buffer.ts         # ObservationBuffer: buffer ring com auto-flush periódico
│   └── hooks.ts          # CaptureHooks: tool_result + before_agent_start handlers
│
├── extract/
│   ├── regex-extractor.ts  # N2: 18 regex patterns inline (<1ms)
│   └── llm-extractor.ts    # N3: LLM via OpenRouter com batching + retry + parsing
│
├── storage/
│   ├── index.ts           # IStorage interface (unificada)
│   ├── sqlite-store.ts    # SQLite + FTS5 (bun:sqlite, WAL mode)
│   ├── json-store.ts      # Cold storage JSON (auditoria/backup)
│   └── unified-store.ts   # Combina SqliteStore + JsonStore
│
├── consolidate/
│   ├── dedup.ts           # N1: normalizeContent, contentHash (SHA256), compositeKey, isContradiction
│   │                      #     dedupByHash, lastFactWins, consolidateN1 (pipeline completo)
│   └── sweep.ts           # N2: SweepConsolidator — scheduler + decay + pruning + TTL
│
├── retrieve/
│   ├── index.ts           # HybridRetriever — orchestrador do pipeline completo
│   ├── bm25.ts            # BM25 via FTS5 com normalização min-max
│   ├── vector.ts          # VectorRetriever — índice RAM dot product
│   ├── reranker.ts        # RerankerService — cross-encoder local + API fallback
│   └── hybrid.ts          # reciprocalRankFusion (RRF, k=60)
│
├── inject/
│   ├── context-builder.ts # buildMemoryBlock, createInjectHandler
│   └── snapshot.ts        # CacheStableInjector (ADR-006): cache snapshot, middle-truncation
│
├── tools/
│   ├── memory-search.ts   # Tool: busca híbrida com filtros type/scope
│   ├── memory-write.ts    # Tool: escrita com pipeline N1 + embedding background
│   └── memory-status.ts   # Tool: estatísticas do sistema
│
└── utils/
    └── embedding.ts       # EmbeddingService (local + API fallback) + cosineSimilarity + normalizeVector
```

## ADRs Implementados

| ADR | Título | Status |
|---|---|---|
| ADR-001 | RawObservation Schema | ✅ |
| ADR-002 | Extraction Levels: N1 none, N2 regex, N3 LLM | ✅ |
| ADR-003 | Hot path: RAM index (vector + cache snapshot) | ✅ |
| ADR-004 | Background sweep consolidator | ✅ |
| ADR-005 | Hybrid retrieval: BM25 + Vector + RRF + Reranker | ✅ |
| ADR-006 | KV Cache-Stable Snapshot (injeção) | ✅ |
| ADR-008 | Local vs API graceful fallback | ✅ |

## Limitações

- Sem extração N3 sem `OPENROUTER_API_KEY`
- Sem vector search sem `@xenova/transformers` ou `OPENROUTER_API_KEY`
- Apenas BM25 no modo base (sem embeddings, sem reranker)
- Pruning/decay desabilitados por padrão (ativar via config)
- Embedding backfill assíncrono — índice vetorial pode ficar desatualizado até completar
- Cold sync (`syncToJson`) não é multi-projeto completo (usa projectId vazio)
- Cache snapshot não persiste entre reinicializações do agente (apenas memória)
