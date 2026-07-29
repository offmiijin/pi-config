# pi-memory

Memória persistente entre sessões para o pi coding agent.

Retém conhecimento através de sessões — preferências, decisões de design, padrões de projeto, lições aprendidas, fatos objetivos — sem depender de API externa obrigatória. 100% local no modo base.

## Instalação

```bash
# A extensão já está em ~/.pi/agent/extensions/pi-memory/, carregada automaticamente.

# Instalar dependências (necessário para vector search local):
cd ~/.pi/agent/extensions/pi-memory && bun install

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
| **EXTRACT** | LLM (default: `openai/gpt-4o-mini` via OpenRouter) processa observações em background após turnos "ricos" (bash/edit/write). Prompt estruturado, parsing multi-formato. Retry automático (3 tentativas). | ✅ (requer `LLM_API_KEY`) |
| **STORE** | SQLite + FTS5 (WAL mode). Triggers FTS5 mantêm índice de texto sincronizado automaticamente. | ✅ |
| **CONSOLIDATE N1** | Dedup por hash SHA256 + último fato vence por chave composta (type+scope+tags). Detecção de contradição via 13 patterns regex PT-BR+EN. Reforço incremental de confidence (+0.05 por reforço, cap 1.0). | ✅ |
| **CONSOLIDATE N2** | Sweep periódico (default: 30min). Agrupa observações pendentes, extrai via LLM, aplica decay de confidence, pruning de memórias obsoletas, limpeza de TTL. | ✅ |
| **RETRIEVE** | BM25 via FTS5 (prefix matching, porter stemmer). Normalização min-max 0-1. | ✅ |
| **RETRIEVE VECTOR** | Embeddings `all-MiniLM-L6-v2` (384 dims) via @xenova/transformers (local, ~80MB). Índice em RAM com dot product (<15ms até 10K memórias). Backfill automático. | ✅ (opt-in) |
| **RETRIEVE HYBRID** | BM25 + Vector → merge scores normalizados com dedup. Graceful degradation se vector indisponível. | ✅ (opt-in) |
| **INJECT** | Bloco `## Persistent Memory` injetado via `before_agent_start`. Cache snapshot estável (ADR-006): bloco congelado entre checkpoints. Middle-truncation quando excede cap. Filtro de prompts triviais. Day rollover força rebuild. | ✅ |

## Arquitetura de Storage (2 camadas)

```
┌─────────────────────────────────────────┐
│ HOT PATH  (latência: 1-50ms)            │
│ Índice em RAM — VectorRetriever dot     │
│ product + CacheStableInjector snapshot  │
├─────────────────────────────────────────┤
│ WARM PATH (latência: 10-200ms)          │
│ SQLite + FTS5 (único DB, WAL mode)      │
│ Triggers sincronizam FTS automaticamente│
└─────────────────────────────────────────┘
```

Sem cold path JSON. SQLite é a única fonte da verdade.

## Tools

| Tool | Descrição |
|---|---|
| `memory_search` | Busca memórias por texto. Busca híbrida (BM25 + vector se disponível). Filtros por type e scope. Exibe score e strategy (bm25/vector/hybrid). |
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
  "extraction_level": "llm",
  "llm_extraction": {
    "enabled": false,
    "model": "openai/gpt-4o-mini",
    "timeout_ms": 5000,
    "sweep_observation_threshold": 100,
    "sweep_interval_ms": 30000,
    "sweep_consolidator_interval_ms": 1800000
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
    "vector": {
      "local": { "enabled": false },
      "api": { "enabled": false, "model": "openai/text-embedding-3-small" }
    },
    "hybrid_enabled": false,
    "default_top_k": 10
  }
}
```

### Projeto (`.pi/memory.json`)

Mesmo formato — sobrescreve campos do global via deep merge.

### Ativação dinâmica

- **LLM extraction**: set `extraction_level: "llm"` e `LLM_API_KEY`. (Requer API key.)
- **Vector search**: set `retrieval.vector.local.enabled: true` (local) ou `retrieval.vector.api.enabled: true` (API). Requer `@xenova/transformers` ou `VECTOR_API_KEY`.
- **Decay/pruning**: set `consolidation.decay_enabled` e `pruning_enabled` (via SweepConsolidator config).

## Extração — LLM (N3)

Extração única via LLM (OpenRouter, OpenAI-compatível). Requer `LLM_API_KEY`.

Fluxo:
1. Turnos ricos (bash/edit/write) disparam `turn_end` → flush buffer → coleta observações pendentes → enfileira no LlmExtractor
2. Ao atingir batchSize (10) ou maxWaitMs (30s), chama LLM
3. Resposta parseada: JSON direto → code block → array inline
4. Cada fato passa pelo pipeline N1 (dedup + last-fact-wins)
5. Observações marcadas como extraídas; retry 3x em falha

Custo estimado: ~$0.0003/fato (gpt-4o-mini via OpenRouter).

**Sem `LLM_API_KEY`, extração automática não acontece.** Apenas fatos escritos via `memory_write` são persistidos.

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

```
[query] → BM25 (FTS5) ──────────────────────┐
         → Vector (dot product RAM, opt-in) ─→ merge scores + dedup → top-K
```

- **BM25**: sempre ativo, via SQLite FTS5 com prefix matching e porter stemmer
- **Vector**: opt-in (`retrieval.vector.local.enabled` ou `retrieval.vector.api.enabled`). Modelo all-MiniLM-L6-v2 local ou API
- **Fusão**: scores normalizados, média quando ambas estratégias retornam mesma memória

Graceful degradation: sem vector, só BM25.

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
├── <project-id>.db          # SQLite + FTS5 (WAL mode)
├── <project-id>.db-shm      # WAL shared memory
└── <project-id>.db-wal      # WAL write-ahead log
```

Projeto ID é hash do diretório (8 chars hex, estável por diretório).

SQLite é a única fonte da verdade. Sem cold path JSON.

## Comandos e Flags

| Comando/Flag | Descrição |
|---|---|
| `pi --no-memory` | Desabilita memória para esta sessão |
| `/memory` | Configuração interativa TUI: vector/llm, decay, pruning. Inclui "Clear all memories" com confirmação |
| `/skill:pi-memory` | Carrega skill com guia de uso das tools |

Após alterar config com `/memory`, execute `/reload` para aplicar as mudanças.

## Dependências

- **Runtime**: Bun ou Node.js (`bun:sqlite` ou `better-sqlite3`)
- **Opcional (embedding local)**: `@xenova/transformers` — WASM/ONNX, ~80MB, modelo all-MiniLM-L6-v2
- **Opcional (LLM extraction)**: `LLM_API_KEY` env var
- **Opcional (vector API)**: `VECTOR_API_KEY` env var
- **Sem APIs externas obrigatórias** — 100% funcional no modo base (BM25-only)

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
│   └── llm-extractor.ts    # LLM via OpenRouter com batching + retry + parsing
│
├── storage/
│   ├── index.ts           # IStorage interface
│   ├── sqlite-store.ts    # SQLite + FTS5 (WAL mode). Única fonte da verdade.
│   ├── sqlite-adapter.ts  # Adapter bun:sqlite / better-sqlite3
│   └── sqlite-factory.ts  # Factory cross-runtime
│
├── consolidate/
│   ├── dedup.ts           # N1: normalizeContent, contentHash, compositeKey,
│   │                      #     dedupByHash, lastFactWins, consolidateN1
│   └── sweep.ts           # N2: SweepConsolidator — scheduler + decay + pruning + TTL
│
├── retrieve/
│   ├── index.ts           # HybridRetriever — BM25 + Vector com merge
│   ├── bm25.ts            # BM25 via FTS5
│   └── vector.ts          # VectorRetriever — índice RAM dot product
│
├── inject/
│   ├── context-builder.ts # buildMemoryBlock, createInjectHandler
│   └── snapshot.ts        # CacheStableInjector: cache snapshot, middle-truncation
│
├── tools/
│   ├── memory-search.ts   # Tool: busca híbrida BM25 + Vector
│   ├── memory-write.ts    # Tool: escrita com pipeline N1 + embedding background
│   └── memory-status.ts   # Tool: estatísticas do sistema
│
└── utils/
    └── embedding.ts       # EmbeddingService + cosineSimilarity + normalizeVector
```

## ADRs Implementados

| ADR | Título | Status |
|---|---|---|
| ADR-001 | RawObservation Schema | ✅ |
| ADR-002 | Extraction Levels: N1 none, N3 LLM (N2 regex removido) | ✅ |
| ADR-003 | Hot path: RAM index (vector + cache snapshot) | ✅ |
| ADR-004 | Background sweep consolidator | ✅ |
| ADR-005 | Hybrid retrieval: BM25 + Vector com merge scores | ✅ |
| ADR-006 | KV Cache-Stable Snapshot (injeção) | ✅ |
| ADR-008 | Local vs API graceful fallback | ✅ |

## Limitações

- **Sem extração automática sem `LLM_API_KEY`.** Apenas fatos escritos via `memory_write` são persistidos.
- Sem vector search sem `@xenova/transformers` ou `VECTOR_API_KEY`
- Apenas BM25 no modo base (sem embeddings)
- Pruning/decay desabilitados por padrão (ativar via config)
- Embedding backfill assíncrono — índice vetorial pode ficar desatualizado até completar
- Cache snapshot não persiste entre reinicializações do agente (apenas em memória)
