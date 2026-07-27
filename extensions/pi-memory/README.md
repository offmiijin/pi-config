# pi-memory

Memória persistente entre sessões para o pi coding agent.

Retém conhecimento através de sessões — preferências, decisões de design, padrões de projeto, lições aprendidas — sem dependências externas. 100% local.

## Instalação

```bash
# A extensão já está em ~/.pi/agent/extensions/pi-memory/
# Carregue normalmente ao iniciar o pi.

# Para desabilitar:
pi --no-memory
```

## Pipeline (6 estágios)

```
CAPTURE → EXTRACT → STORE → CONSOLIDATE → RETRIEVE → INJECT
```

| Estágio | O que faz | Status |
|---|---|---|
| **CAPTURE** | Toda tool call gera uma observação bruta (fire-and-forget, TTL 7 dias) | ✅ Fase 1 |
| **EXTRACT** | Regex + LLM transformam observações em fatos semânticos | 🔜 Fase 2 |
| **STORE** | SQLite + FTS5 (warm) + JSON em disco (cold) | ✅ Fase 1 |
| **CONSOLIDATE** | Dedup por hash SHA256 + último fato vence por chave composta | ✅ Fase 1 (N1) |
| **RETRIEVE** | BM25 via FTS5 com prefix matching + injeção automática no system prompt | ✅ Fase 1 |
| **INJECT** | Bloco `## Persistent Memory` com top-5 memórias (cap 4KB) no `before_agent_start` | ✅ Fase 1 |

## Arquitetura de Storage (3 camadas)

```
┌────────────────────────────────┐
│ HOT PATH  (latência: 1-50ms)   │ ← Fase 3
│ Índice em RAM (BM25 + faiss)  │
├────────────────────────────────┤
│ WARM PATH (latência: 10-200ms) │ ← Fase 1 ✅
│ SQLite + FTS5 (bun:sqlite)    │
├────────────────────────────────┤
│ COLD PATH (latência: 100ms-2s) │ ← Fase 1 ✅
│ JSON em disco (auditoria)      │
│ ~/.pi/agent/memory/data/       │
└────────────────────────────────┘
```

## Tools

| Tool | Descrição |
|---|---|
| `memory_search` | Busca memórias por texto. Filtra por type (preference/decision/lesson/fact/pattern) e scope (project/user/global) |
| `memory_write` | Salva preferência, decisão, padrão, fato ou lição. Dedup automático por hash + último fato vence |
| `memory_status` | Estatísticas: total de memórias ativas/superseded, breakdown por tipo/scope, confidence média, observações pendentes |

## Tipos de Memória

| Tipo | Uso | Exemplo |
|---|---|---|
| `preference` | Preferência do usuário/time | `"Prefere pnpm em vez de npm"` |
| `decision` | Decisão de arquitetura/design | `"Payment API segue hexagonal architecture"` |
| `fact` | Fato objetivo sobre o projeto | `"CI/CD usa GitHub Actions com deploy no ECS"` |
| `pattern` | Padrão de código/projeto recorrente | `"Testes usam describe/it/expect do vitest"` |
| `lesson` | Lição aprendida com erro/acerto | `"Timeout do OAuth era 5min, não 30s — causava 401"` |

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
    "model": "gpt-4o-mini",
    "timeout_ms": 5000,
    "sweep_observation_threshold": 50,
    "sweep_interval_ms": 1800000
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

Mesmo formato — sobrescreve campos do global.

## Consolidação N1 (automática)

### Dedup por hash

```
Nova memória → SHA256 do texto normalizado
  → Se hash já existe: reforça existente (+confidence, +access_count)
  → Se não: cria nova
```

### Último fato vence

```
Chave = type + scope + tags
  → Se chave existe e NOVA contradiz EXISTENTE:
    Marca antiga como superseded, cria nova
  → Se chave existe e NÃO contradiz:
    Atualiza texto e confidence da existente
```

### Detecção de contradição

13 patterns regex em PT-BR:
- `"não usa mais"`, `"parou de usar"`
- `"mudou para"`, `"alterado para"`, `"migrou para"`
- `"agora prefere"`, `"agora usa"`, `"substituído por"`
- `"em vez de"`, `"ao invés de"`, `"no lugar de"`
- `"descontinuado"`, `"deprecated"`, `"obsoleto"`
- `"nunca use"`, `"evite usar"`

## Filesystem

```
~/.pi/agent/memory/
├── config.json              # Configuração global
├── <project-id>.db          # SQLite + FTS5 (warm storage)
├── <project-id>.db-shm      # WAL shared memory
├── <project-id>.db-wal      # WAL write-ahead log
└── data/
    ├── memories.json        # Cold storage: array de Memory
    └── observations.json    # Cold storage: array de RawObservation
```

## Comandos e Flags

| Comando/Flag | Descrição |
|---|---|
| `pi --no-memory` | Desabilita memória para esta sessão |
| `/skill:pi-memory` | Carrega skill com guia de uso das tools |

## Dependências

- **Bun** (`bun:sqlite`) — nativo, zero deps externas
- Sem APIs externas, sem embeddings (100% local na Fase 1)

## Limitações (Fase 1)

- Sem extração LLM (N3) — apenas captura bruta de tool calls
- Sem busca vetorial (embeddings) — apenas BM25 lexical
- Sem decay/pruning automático — apenas dedup e last-fact-wins
- Sem suporte multi-projeto avançado — project ID é hash do diretório
