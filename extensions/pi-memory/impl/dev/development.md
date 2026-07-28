# Plano de Desenvolvimento — pi-memory

## Ordem Sequencial de Implementação

Cada fase lista tarefas na ordem em que DEVEM ser implementadas. Tarefas dentro da mesma fase podem ser paralelizadas se não tiverem dependência entre si.

---

## Fase 1: Fundação (MVP)

### 1.1 — Estrutura do Projeto
- [x] Criar `package.json` com dependências: `better-sqlite3`
- [x] Criar `types.ts` com todas as interfaces (Memory, RawObservation, Config, etc.)
- [x] Criar `config.ts` com `loadConfig()` (global + project-local)
- [x] Criar `index.ts` (factory principal) com esqueleto: `export default function(pi: ExtensionAPI) {}`

### 1.2 — STORAGE (Warm + Cold)
- [x] `storage/sqlite-store.ts`: classe `SqliteStore`
  - `open()`: abre/ cria database, executa schema DDL
  - `insertMemory(memory)`: INSERT + trigger FTS5 sync
  - `insertObservation(obs)`: INSERT com TTL
  - `getMemory(id)`: SELECT by id
  - `getMemoriesByProject(projectId)`: SELECT com filtro
  - `close()`: fecha database
- [x] `storage/json-store.ts`: classe `JsonStore`
  - `writeMemories(memories)`: escreve `data/memories.json`
  - `writeObservations(observations)`: escreve `data/observations.json`
  - `readMemories()`: lê `data/memories.json`
  - `readObservations()`: lê `data/observations.json`
- [x] `storage/index.ts`: interface `IStorage` unificando SqliteStore + JsonStore

### 1.3 — CAPTURE
- [x] `capture/buffer.ts`: classe `ObservationBuffer`
  - `enqueue(obs)`: adiciona ao buffer
  - `flush()`: escreve buffer para storage
  - `size()`: número de observações pendentes
- [x] `capture/hooks.ts`: handlers de eventos
  - `onToolResult(event, ctx)`: cria RawObservation, enfileira no buffer
  - `onBeforeAgentStart(event, ctx)`: registra user prompt
  - `onSessionShutdown(event, ctx)`: flush buffer

### 1.4 — CONSOLIDATE (N1 apenas)
- [x] `consolidate/dedup.ts`: funções puras
  - `normalizeObservation(obs)`: remove timestamps, UUIDs, paths absolutos
  - `dedupByHash(obs, existing)`: SHA256 check
  - `lastFactWins(newMemory, existing)`: chave composta, detecção de contradição

### 1.5 — RETRIEVE (BM25 apenas)
- [x] `retrieve/bm25.ts`: classe `Bm25Retriever`
  - `search(query, projectId, topK)`: FTS5 MATCH query
  - `formatResults(results)`: formata para injeção

### 1.6 — INJECT (Simples)
- [x] `inject/context-builder.ts`: função `buildMemoryBlock(memories)`
  - Formata top-5 memórias como bullet points
  - Cap: 4KB
- [x] `inject/context-builder.ts`: handler `onBeforeAgentStart`
  - Busca memórias com `retrieve.search(event.prompt)`
  - Injeta bloco no `systemPrompt`

### 1.7 — Tools
- [x] `tools/memory-search.ts`: tool `memory_search`
  - Parâmetros: query, type?, scope?
  - Usa `retrieve.search()`
- [x] `tools/memory-write.ts`: tool `memory_write`
  - Parâmetros: text, type, tags?, scope?
  - Cria Memory, persiste no storage
- [x] `tools/memory-status.ts`: tool `memory_status`
  - Retorna estatísticas: total memories, observations, index status

### 1.8 — Integração no `index.ts`
- [x] Registrar flag `--no-memory`
- [x] `session_start`: init storage, carregar config, status na footer
- [x] `tool_result`: handler de captura
- [x] `before_agent_start`: handler de injeção
- [x] `session_shutdown`: flush + fechar storage
- [x] Registrar tools: `memory_search`, `memory_write`, `memory_status`

---

## Fase 2: Inteligência

### 2.1 — EXTRACT (N2: Regex)
- [ ] `extract/regex-extractor.ts`: classe `RegexExtractor`
  - Array de patterns com nome e regex
  - `extract(observation)`: aplica patterns, retorna `ExtractedFact[]`
- [ ] Integrar em `capture/hooks.ts`: chamar `regexExtractor.extract()` no `tool_result`

### 2.2 — EXTRACT (N3: LLM Background)
- [ ] `extract/llm-extractor.ts`: classe `LlmExtractor`
  - `extract(observations[], signal)`: chama LLM barato, retorna fatos
  - Prompt engineering: "Extraia fatos atômicos..."
  - Timeout: 5s
- [ ] Integrar em `capture/hooks.ts`: enfileirar extração N3 no `turn_end` (turnos ricos)

### 2.3 — CONSOLIDATE (N2: Background Sweep)
- [ ] `consolidate/sweep.ts`: classe `SweepConsolidator`
  - `run()`:
    1. SELECT obs não extraídas, agrupadas
    2. Para cada grupo: chama `llmExtractor.extract()`
    3. Insere memórias (passam pelo N1)
    4. Marca obs como extracted=1
    5. Decay: reduz confidence de memórias antigas
    6. Pruning: deleta memórias abaixo do threshold
    7. Limpeza de TTL: deleta obs expiradas
  - `schedule()`: setInterval (30 min) ou trigger por contagem (50 obs)
- [ ] Integrar em `index.ts`: iniciar scheduler no `session_start`

### 2.4 — RETRIEVE (Vector Search)
- [ ] `utils/embedding.ts`: classe `EmbeddingService`
  - `initialize()`: baixa e carrega modelo `all-MiniLM-L6-v2`
  - `embed(text)`: gera vetor (384 dims)
  - Usa `@xenova/transformers`
- [ ] `retrieve/vector.ts`: classe `VectorRetriever`
  - `buildIndex(memories)`: cria índice faiss com todos os embeddings
  - `search(query, topK)`: embed query → faiss search
- [ ] Atualizar `storage/sqlite-store.ts`: coluna `embedding BLOB`
- [ ] Script de backfill: gerar embeddings para memórias existentes sem embedding

### 2.5 — RETRIEVE (RRF + Reranker)
- [ ] `retrieve/hybrid.ts`: função `fuseResults()`
  - Implementa Reciprocal Rank Fusion (k=60)
  - Recebe arrays de resultados de BM25, Vector, (Graph futuro)
- [ ] `retrieve/reranker.ts`: classe `RerankerService`
  - `initialize()`: carrega modelo cross-encoder
  - `rerank(query, documents)`: rerankeia top-20
- [ ] `retrieve/index.ts`: classe `HybridRetriever`
  - `search(query, projectId, topK)`:
    1. Paralelo: BM25 + Vector
    2. RRF merge
    3. Reranker (se top-20)
    4. Retorna top-K

### 2.6 — INJECT (KV Cache-Stable Snapshot)
- [ ] `inject/snapshot.ts`: classe `CacheStableInjector`
  - `getMemoryBlock(prompt)`: reconstrói ou reusa snapshot
  - Checkpoints de invalidação: `session_start`, `session_before_compact`, `memory_write:long_term`, day rollover
  - `buildMemoryBlock()`: scratchpad + daily + persistent + yesterday
  - Cap total: 16KB
- [ ] Integrar em `index.ts`: substituir handler `before_agent_start` simples

---

## Fase 3: Robustez

### 3.1 — STORAGE (Hot Index em RAM)
- [ ] `storage/ram-index.ts`: classe `RamIndex`
  - `build(memories)`: reconstrói índice BM25 + faiss do cold storage
  - `search(query, topK)`: busca híbrida direto na RAM
  - `insert(memory)`: insere no índice (online, sem rebuild)
  - `remove(id)`: remove do índice
  - `update(memory)`: remove + insert
- [ ] Integrar em `index.ts`:
  - `session_start`: `ramIndex.build(allMemories)`
  - Substituir `retrieve.search()` para usar `ramIndex` quando disponível
  - Fallback para FTS5 quando RAM frio

### 3.2 — INJECT (Memory Gateway)
- [ ] `inject/gateway.ts`: classe `MemoryGateway`
  - `judge(prompt, memories)`: heurístico (score thresholds)
    - Top score > 0.9 E ≥3 results → "KNOWN"
    - Top score > 0.8 → "PRIOR"
    - else → "NONE"
  - Com metadata (v2): penaliza idade, contradições
- [ ] Integrar em `index.ts`:
  - No `before_agent_start`, chamar gateway antes de decidir o que injetar
  - "KNOWN": injeta resposta direta, instrui não explorar
  - "PRIOR": injeta contexto, permite verificação
  - "NONE": pula injeção

### 3.3 — CONSOLIDATE (N3: /memory-dream)
- [ ] `consolidate/dream.ts`: classe `DreamConsolidator`
  - `run(projectId)`:
    1. Busca todas as memórias
    2. Agrupa por similaridade de embedding
    3. Para cada grupo: chama LLM potente para decidir merge/contradição/mantém
    4. Gera relatório de ações planejadas
    5. Aguarda confirmação do usuário
    6. Executa ações confirmadas
- [ ] `tools/memory-dream.ts`: comando `/memory-dream`
  - Handler que invoca `dreamConsolidator.run()`
  - UI: mostra relatório, pede confirmação para cada ação

### 3.4 — Decay + Pruning Automático
- [ ] Integrar no `sweep.ts`:
  - Decay: `confidence *= 0.9` para memórias com `last_accessed > 7 dias`
  - Pruning: DELETE com `confidence < 0.1 AND last_accessed > 30 dias`
  - Pinned: imune a decay e pruning
  - Audit log: toda deleção registrada

---

## Fase 4: Produto

### 4.1 — EXTRACT (N4: Entity Resolution)
- [ ] `extract/entity-resolver.ts`: classe `EntityResolver`
  - `resolve(entities[])`: fuzzy matching + embedding similarity
  - `linkage(entities[])`: cria arestas SAME_AS com confiança
  - Threshold: 0.95 para merge automático

### 4.2 — EXTRACT (N4: Relation Extraction)
- [ ] `extract/relation-extractor.ts`: classe `RelationExtractor`
  - `extract(facts, entities)`: LLM extrai relações (subject, predicate, object)
  - Suporte a relações de código: DEPENDS_ON, IMPORTS, EXTENDS, IMPLEMENTS, DEPLOYED_VIA

### 4.3 — EXTRACT (N4: Temporal Grounding)
- [ ] `extract/temporal-grounder.ts`: classe `TemporalGrounder`
  - `ground(relations, observations)`: adiciona valid_from/valid_until
  - Fontes: timestamp explícito, timestamp do turno, inferência

### 4.4 — RETRIEVE (Graph Traversal)
- [ ] `retrieve/graph.ts`: classe `GraphRetriever`
  - `search(query, entities)`: busca por entidades + traversals
  - Suporte a queries multi-hop

### 4.5 — INJECT (Judge LLM-based)
- [ ] `inject/gateway.ts`: modo LLM
  - Substitui heurística por LLM call: "Can the query be fully answered?"
  - Modelo: gpt-4o-mini (barato)

### 4.6 — Compatibilidade Markdown
- [ ] Export: `~/.pi/agent/memory/MEMORY.md`
- [ ] Export: `~/.pi/agent/memory/daily/YYYY-MM-DD.md`
- [ ] Export: `~/.pi/agent/memory/SCRATCHPAD.md`
- [ ] Formato compatível com pi-memory (jayzeng)

---

## Dependências entre Fases

```
Fase 1 (Fundação)
  ├── 1.1 Estrutura ──► 1.2 Storage ──► 1.3 Capture ──► 1.4 Consolidate N1
  │                                              │
  │                                              ▼
  │                                        1.5 Retrieve BM25
  │                                              │
  │                                              ▼
  │                                    1.6 Inject + 1.7 Tools
  │                                              │
  │                                              ▼
  │                                        1.8 Integração
  │
  ▼
Fase 2 (Inteligência)
  ├── 2.1 Extract N2 ──► 2.2 Extract N3 ──► 2.3 Consolidate N2
  │                                              │
  │                     ┌────────────────────────┘
  │                     ▼
  │              2.4 Vector ──► 2.5 RRF + Reranker
  │                                  │
  │                                  ▼
  │                            2.6 Snapshot
  │
  ▼
Fase 3 (Robustez)
  ├── 3.1 Hot Index (depende de 2.4)
  ├── 3.2 Gateway (depende de 3.1)
  ├── 3.3 Dream (depende de 2.2, 2.4)
  └── 3.4 Decay (já integrado em 2.3)

Fase 4 (Produto)
  ├── 4.1 Entity Resolver ──► 4.2 Relations ──► 4.3 Temporal
  │                                                 │
  │                                                 ▼
  │                                           4.4 Graph Traversal
  ├── 4.5 Judge LLM (depende de 3.2)
  └── 4.6 Markdown Export (depende de 1.2)
```

---

## Estimativa de Tempo

| Fase | Complexidade | Tempo estimado |
|---|---|---|
| Fase 1: Fundação | Média | 2-3 semanas |
| Fase 2: Inteligência | Alta | 1-2 semanas |
| Fase 3: Robustez | Alta | 1-2 semanas |
| Fase 4: Produto | Muito Alta | 2-4 semanas |
| **Total** | | **6-11 semanas** |
