# RETRIEVE — Detalhes de Implementação

## Objetivo

Recuperar as memórias mais relevantes para um dado query, combinando múltiplas estratégias de busca (BM25 lexical + Vector semântico + Graph relacional) e rerankeando os resultados para máxima precisão.

## Pipeline de Retrieval

```
query: "como fazer deploy do payment-api?"

┌──────────────────────────────────────────────────────────────┐
│ FASE 1: MULTI-STRATEGY SEARCH (paralela, ~50ms)              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ BM25 (FTS5)  │  │ Vector(faiss)│  │ Graph (futuro)│      │
│  │              │  │              │  │              │       │
│  │ lexical      │  │ semântico    │  │ relacional   │       │
│  │ top-20       │  │ top-20       │  │ top-10       │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │                 │                 │               │
│         └─────────────────┼─────────────────┘               │
│                           │                                  │
│                           ▼                                  │
│ FASE 2: RECIPROCAL RANK FUSION (<1ms)                        │
│         score = Σ 1/(k + rank_i) para cada estratégia        │
│         k = 60                                               │
│                           │                                  │
│                           ▼                                  │
│         top-20 fundido                                       │
│                           │                                  │
│                           ▼                                  │
│ FASE 3: CROSS-ENCODER RERANKER (~100ms)                      │
│         Para cada doc no top-20:                             │
│           cross-encoder(query, doc.text) → score [0,1]      │
│                           │                                  │
│                           ▼                                  │
│         top-10 final → retorna para o caller                 │
└──────────────────────────────────────────────────────────────┘

LATÊNCIA TOTAL: ~150ms
```

---

## Estratégia 1: BM25 Lexical (via SQLite FTS5)

### Implementação

```typescript
class Bm25Retriever {
  constructor(private storage: SqliteStore) {}

  async search(
    query: string,
    projectId: string,
    topK: number = 20,
  ): Promise<ScoredMemory[]> {
    const sanitized = this.sanitizeFts5Query(query);
    if (!sanitized) return [];

    // FTS5 query com ranking BM25 nativo
    const results = await this.storage.db!.prepare(`
      SELECT
        m.*,
        bm25(memories_fts) as bm25_score
      FROM memories m
      JOIN memories_fts ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND m.project_id = ?
        AND m.superseded_by IS NULL
      ORDER BY bm25_score
      LIMIT ?
    `).all(sanitized, projectId, topK);

    return results.map(row => ({
      ...row,
      score: this.normalizeBm25Score(row.bm25_score),
      strategy: "bm25",
    }));
  }

  private sanitizeFts5Query(query: string): string {
    // Remove caracteres que quebram syntax FTS5
    let sanitized = query
      .replace(/['"*()^]/g, "")   // remove FTS5 special chars
      .replace(/[^\w\s]/g, " ")   // remove pontuação
      .replace(/\s+/g, " ")       // normaliza espaços
      .trim();

    if (!sanitized) return "";

    // Adiciona prefix matching para cada termo
    // "deploy payment" → "deploy* payment*"
    const terms = sanitized.split(/\s+/);
    return terms.map(t => {
      if (t.length >= 3) return `${t}*`;
      return t;
    }).join(" ");
  }

  private normalizeBm25Score(rawScore: number): number {
    // BM25 scores são negativos e variam de -inf a 0
    // Normaliza para [0, 1]
    // Scores típicos: -10 (irrelevante) a -1 (muito relevante)
    if (rawScore >= 0) return 0;
    return 1 / (1 + Math.abs(rawScore));
  }
}
```

### Exemplo de Query FTS5

```
Input:  "deploy payment-api Kubernetes"
Sanitized: "deploy* payment* kubernetes*"
FTS5:    MATCH 'deploy* payment* kubernetes*'

Resultados:
  doc1: "deploy do payment-api usa ArgoCD no Kubernetes"  → score: -1.2 → norm: 0.45
  doc2: "deploy do gateway requer Helm charts"            → score: -2.1 → norm: 0.32
  doc3: "payment-api precisa de deploy manual"            → score: -3.0 → norm: 0.25
```

---

## Estratégia 2: Vector Semantic (via Faiss)

### Dependência de Embedding

```typescript
import { pipeline } from "@xenova/transformers";

class EmbeddingService {
  private extractor: any = null;
  private readonly MODEL = "Xenova/all-MiniLM-L6-v2";
  private readonly DIMS = 384;

  async initialize(): Promise<void> {
    // Download do modelo (~80MB, cache em ~/.cache/huggingface)
    this.extractor = await pipeline("feature-extraction", this.MODEL);
  }

  async embed(text: string): Promise<number[]> {
    if (!this.extractor) throw new Error("Embedding service not initialized");

    const result = await this.extractor(text, {
      pooling: "mean",
      normalize: true, // normaliza para unit vector (cosine → inner product)
    });

    return Array.from(result.data) as number[];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Processa em lotes para eficiência
    const batchSize = 32;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      for (const text of batch) {
        results.push(await this.embed(text));
      }
    }

    return results;
  }

  isReady(): boolean {
    return this.extractor !== null;
  }
}
```

### Vector Retriever

```typescript
class VectorRetriever {
  constructor(
    private ramIndex: RamIndex,
    private embeddingService: EmbeddingService,
  ) {}

  async search(
    query: string,
    _projectId: string,
    topK: number = 20,
  ): Promise<ScoredMemory[]> {
    if (!this.embeddingService.isReady()) return [];
    if (!this.ramIndex.isReady()) return [];

    const queryVec = await this.embeddingService.embed(query);
    const results = this.ramIndex.faissSearch(queryVec, topK);

    return results.map(r => ({
      ...r,
      strategy: "vector",
    }));
  }
}
```

### Exemplo de Vector Search

```
Query:  "como publicar o serviço de pagamento no Kubernetes?"

BM25 falha: "publicar" ≠ "deploy", "serviço de pagamento" ≠ "payment-api"

Vector acerta:
  Query embed:    [0.03, -0.42, 0.81, 0.15, ..., -0.09]
  Doc "payment-api deploy via ArgoCD no k8s":
    embed:        [0.02, -0.44, 0.79, 0.18, ..., -0.07]
  Cosine: 0.94 → TOP RESULT!

  Doc "gateway deploy com Docker Compose":
    embed:        [0.01, -0.20, 0.35, 0.40, ..., -0.15]
  Cosine: 0.62 → relevante mas menos
```

---

## Estratégia 3: Graph Traversal (Futuro — Fase 4)

### Especificação de Interface

```typescript
interface GraphRetriever {
  search(
    query: string,
    entities: string[],    // entidades mencionadas na query
    projectId: string,
    topK: number,
  ): Promise<ScoredMemory[]>;

  // Queries especializadas
  findDependents(entity: string): Promise<string[]>;
  findDependencies(entity: string): Promise<string[]>;
  findRelatedFiles(entity: string): Promise<string[]>;
}
```

### Esboço de Implementação (não implementado)

```typescript
class KuzuGraphRetriever implements GraphRetriever {
  private db: any; // KuzuDB instance

  async search(query, entities, projectId, topK): Promise<ScoredMemory[]> {
    if (entities.length === 0) return [];

    // Busca entidades matching
    const entityIds = await this.resolveEntities(entities, projectId);

    // Traversal: entidade → arestas → entidades relacionadas → memórias
    const results = await this.db.execute(`
      MATCH (e:Entity)-[r]-(related:Entity)
      WHERE e.id IN $entityIds
      MATCH (related)-[:DESCRIBED_BY]->(m:Memory)
      WHERE m.project_id = $projectId
      RETURN m, count(r) as relevance
      ORDER BY relevance DESC
      LIMIT $topK
    `);

    return results.map(row => ({
      ...row.m,
      strategy: "graph",
      score: Math.min(1.0, row.relevance / 10),
    }));
  }
}
```

---

## Reciprocal Rank Fusion (RRF)

### Algoritmo

```typescript
function reciprocalRankFusion(
  resultSets: Array<Array<{ id: string; score: number }>>,
  topK: number,
  k: number = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const { id } = results[rank];
      const current = scores.get(id) ?? 0;

      // RRF formula: 1 / (k + rank)
      // rank começa em 0, então +1 para evitar divisão por zero
      scores.set(id, current + 1 / (k + rank + 1));
    }
  }

  // Ordena por score RRF decrescente
  return Array.from(scores.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, topK)
    .map(([id, score]) => ({ id, score }));
}
```

### Por que RRF em vez de Weighted Sum?

```
Weighted Sum: score = w1 * bm25_score + w2 * vector_score

Problema: scores de estratégias diferentes têm escalas diferentes.
  BM25:  tipicamente 0.1 — 0.5
  Vector: tipicamente 0.5 — 0.95
  → Vector DOMINA se w1 = w2

Solução ingênua: normalizar scores para [0,1]
  Problema: a distribuição importa. Se BM25 retorna 20 docs com
  scores [0.45, 0.44, 0.43, ...] e Vector retorna [0.95, 0.45, 0.12, ...],
  o doc BM25 #20 (score 0.12 normalizado) seria tratado como tão bom
  quanto o Vector #2 (score 0.95 normalizado para ~0.5).
  → ISSO NÃO É VERDADE.

RRF resolve isso: SÓ IMPORTA O RANK, não o valor absoluto.
  BM25 rank 1:  1/(60+1) = 0.0164
  Vector rank 1: 1/(60+1) = 0.0164
  → MESMO PESO independente da escala original!

  Doc que aparece rank 1 no BM25 E rank 3 no Vector:
    score = 1/61 + 1/63 = 0.0164 + 0.0159 = 0.0323
  Doc que aparece rank 2 no BM25 E rank 1 no Vector:
    score = 1/62 + 1/61 = 0.0161 + 0.0164 = 0.0325
  → Scores muito próximos. RRF naturalmente balanceia.
```

### Exemplo Numérico

```
Query: "deploy payment-api"

BM25 results:              Vector results:
  1. id=A score=0.45        1. id=B score=0.92
  2. id=B score=0.32        2. id=C score=0.88
  3. id=D score=0.28        3. id=A score=0.81

RRF fusion (k=60):

  id=A: 1/(60+1) + 1/(60+3) = 1/61 + 1/63 = 0.0164 + 0.0159 = 0.0323
  id=B: 1/(60+2) + 1/(60+1) = 1/62 + 1/61 = 0.0161 + 0.0164 = 0.0325
  id=C: 0/(n/a)   + 1/(60+2) = 0       + 1/62 = 0.0161
  id=D: 1/(60+3) + 0/(n/a)   = 1/63 + 0       = 0.0159

Resultado RRF:
  1. id=B: 0.0325  (forte em vector, bom em BM25)
  2. id=A: 0.0323  (forte em BM25, bom em vector)
  3. id=C: 0.0161  (só vector)
  4. id=D: 0.0159  (só BM25)
```

---

## Cross-Encoder Reranker

### Por que Reranker?

BM25 e Vector são "cegos" — operam em tokens/embeddings, não entendem significado real. O reranker LÊ o texto completo do documento e da query e decide relevância real.

### Implementação

```typescript
class RerankerService {
  private model: any = null;
  private readonly MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

  async initialize(): Promise<void> {
    // Cross-encoder para ranking (≠ feature-extractor para embeddings)
    this.model = await pipeline("text-classification", this.MODEL);
    // Nota: @xenova/transformers não suporta cross-encoder diretamente.
    // Alternativa: usar @xenova/transformers com modelo específico
    // ou implementar manualmente com ONNX runtime.
  }

  async rerank(
    query: string,
    documents: ScoredMemory[],
  ): Promise<ScoredMemory[]> {
    if (!this.model) return documents; // fallback: sem reranker

    const pairs = documents.map(doc => ({
      text: `[CLS] ${query} [SEP] ${doc.text} [SEP]`,
      doc,
    }));

    // Batch inference
    const scores: number[] = [];
    for (const pair of pairs) {
      const result = await this.model(pair.text);
      scores.push(result[0].score);
    }

    // Combina score original do retrieval com score do reranker
    const combined = documents.map((doc, i) => ({
      ...doc,
      retrievalScore: doc.score,
      rerankerScore: scores[i],
      score: 0.3 * doc.score + 0.7 * scores[i], // 70% peso do reranker
    }));

    return combined.sort((a, b) => b.score - a.score);
  }
}
```

### Exemplo de Reranker em Ação

```
Query: "como fazer deploy do payment-api?"

Pré-reranker (BM25 + Vector RRF):
  1. [0.89] "deploy do payment-api FALHOU 3 vezes essa semana"
  2. [0.82] "NUNCA use deploy automático no payment-api"
  3. [0.78] "payment-api: guia de deploy com Helm + ArgoCD"
  4. [0.71] "rollback do payment-api em produção"

Reranker lê cada (query, doc) como par:
  1. score: 0.12 — "FALHOU" não é sobre COMO fazer deploy
  2. score: 0.05 — "NUNCA use" → NEGAÇÃO, irrelevante
  3. score: 0.94 — "guia de deploy" → É exatamente o que a query pede!
  4. score: 0.08 — "rollback" → tópico diferente

Pós-reranker:
  1. [0.89] "payment-api: guia de deploy com Helm + ArgoCD"  (subiu de #3)
  2. [0.30] "deploy do payment-api FALHOU 3 vezes"            (caiu de #1)
  3. [0.24] "rollback do payment-api em produção"             (caiu de #4)
  4. [0.17] "NUNCA use deploy automático"                     (caiu de #2)
```

---

## Hybrid Retriever (Orquestrador)

```typescript
class HybridRetriever {
  constructor(
    private bm25: Bm25Retriever,
    private vector: VectorRetriever,
    private ramIndex: RamIndex,
    private reranker: RerankerService,
    private graph?: GraphRetriever, // futuro
  ) {}

  async search(
    query: string,
    projectId: string,
    topK: number = 10,
  ): Promise<ScoredMemory[]> {
    // Tenta hot path (RAM index)
    if (this.ramIndex.isReady()) {
      return this.ramIndex.search(query, topK);
    }

    // Warm path: estratégias em paralelo
    const strategies: Promise<ScoredMemory[]>[] = [
      this.bm25.search(query, projectId, topK * 2),
      this.vector.search(query, projectId, topK * 2),
    ];

    if (this.graph) {
      strategies.push(this.graph.search(query, [], projectId, topK));
    }

    const results = await Promise.all(strategies);

    // RRF fusion
    const fused = reciprocalRankFusion(
      results.map(r => r.map(({ id, score }) => ({ id, score }))),
      topK * 2,
    );

    // Resolve IDs para objetos Memory
    const fusedMemories = fused
      .map(f => results.flat().find(r => r.id === f.id))
      .filter(Boolean) as ScoredMemory[];

    // Reranker (se disponível)
    const reranked = await this.reranker.rerank(query, fusedMemories);

    return reranked.slice(0, topK);
  }
}
```

---

## Cache de Retrieval

Para queries repetidas (ex: mesmo prompt em retry), cache em memória:

```typescript
class RetrievalCache {
  private cache = new Map<string, { results: ScoredMemory[]; timestamp: number }>();
  private readonly TTL_MS = 60_000; // 1 minuto

  get(key: string): ScoredMemory[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return entry.results;
  }

  set(key: string, results: ScoredMemory[]): void {
    this.cache.set(key, { results, timestamp: Date.now() });
  }

  buildKey(query: string, projectId: string, topK: number): string {
    return `${projectId}:${query.slice(0, 100)}:${topK}`;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
```

Invalidar cache quando:
- Nova memória é adicionada (pode ser mais relevante)
- Memória é deletada/superseded
- Sweep de consolidação altera memórias existentes

---

## Métricas de Retrieval

```
Retrieval:
  Total queries: 234
  Cache hits:    67 (28.6%)
  Avg latency:   45ms (hot path) / 150ms (warm path)

  Strategy breakdown:
    Hot (ram index):  189 (80.7%)
    Warm (FTS5):       30 (12.8%)
    Cold (fallback):   15 (6.4%)

  Reranker:
    Enabled: yes (Xenova/ms-marco-MiniLM-L-6-v2)
    Avg rerank time: 95ms (top-20 docs)
    Score delta (avg): 0.17 (diferença entre pré e pós reranker)

  Accuracy (amostragem manual, n=50):
    Top-1 relevante:   88% (44/50)
    Top-3 relevante:   94% (47/50)
    Top-5 relevante:   98% (49/50)
```

---

## Edge Cases

### Query vazia ou muito curta
- Query com <3 caracteres: skip vector search (não gera embedding útil)
- Usa apenas BM25 para termos curtos

### Nenhum resultado
- Retorna array vazio (não quebra o pipeline)
- INJECT etapa pula injeção
- LLM continua sem contexto de memória (fallback natural)

### Muitos resultados (>100)
- Limite hard: topK * 3 = 30 docs entram no reranker
- Reranker escala O(N) — N=30 é seguro (~150ms)

### Embedding service offline
- Vector retriever retorna array vazio
- RRF funciona com 1 estratégia (BM25 apenas) — sem erro
- Métricas registram "vector_unavailable"
