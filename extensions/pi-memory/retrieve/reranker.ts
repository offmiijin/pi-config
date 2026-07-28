/**
 * RerankerService — Cross-encoder reranker, ADR-005, Fase 2.5.
 *
 * Usa modelo cross-encoder (ms-marco-MiniLM-L-6-v2) para re-ranquear
 * documentos candidatos com precisão superior a BM25 ou vector search isolados.
 *
 * Cross-encoder processa o par (query, document) em conjunto — mais lento que
 * bi-encoder (~5ms/par) mas muito mais preciso para ranking final.
 *
 * ADR-005: aplicado ao top-20 do RRF fusion, reduz para top-10 final.
 * ADR-008: modelo ~80MB via @xenova/transformers.
 *
 * Fallback: se modelo não carregar, reranker é skipped (HybridRetriever
 * retorna resultados RRF sem rerank).
 */

// ── Tipos ──────────────────────────────────────────────────────────────

export interface RerankerDocument {
  /** Identificador único do documento (memory.id) */
  id: string;
  /** Texto do documento para cross-encoding */
  text: string;
}

export interface RerankerResult {
  /** Identificador do documento */
  id: string;
  /** Score de relevância [0, 1] */
  score: number;
}

export interface RerankerConfig {
  /** Modelo cross-encoder. Default: Xenova/ms-marco-MiniLM-L-6-v2 */
  model: string;
  /** Timeout de download do modelo em ms. Default: 30000 */
  modelDownloadTimeoutMs: number;
  /** Máximo de documentos por batch. Default: 20 */
  maxBatchSize: number;
}

const DEFAULTS: RerankerConfig = {
  model: "Xenova/ms-marco-MiniLM-L-6-v2",
  modelDownloadTimeoutMs: 30_000,
  maxBatchSize: 20,
};

// ── RerankerService ────────────────────────────────────────────────────

export class RerankerService {
  private pipeline: unknown = null;
  private ready = false;
  private initError: string | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly config: RerankerConfig;

  constructor(config: Partial<RerankerConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Inicializa o modelo cross-encoder (lazy, chamado no primeiro rerank). */
  async initialize(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  /**
   * Re-rankeia documentos contra uma query.
   *
   * @param query - Query de busca (prompt do usuário)
   * @param documents - Lista de documentos a re-ranquear (maxBatchSize)
   * @returns Documentos com scores cross-encoder, ordenados por relevância
   */
  async rerank(
    query: string,
    documents: RerankerDocument[]
  ): Promise<RerankerResult[]> {
    await this.initialize();
    if (!this.ready) {
      throw new Error(`RerankerService not ready: ${this.initError}`);
    }

    if (documents.length === 0) return [];

    // Limita ao batch size
    const batch = documents.slice(
      0,
      Math.min(documents.length, this.config.maxBatchSize)
    );

    // Cross-encode cada par (query, document)
    const scores: RerankerResult[] = [];
    for (const doc of batch) {
      try {
        const score = await this.crossEncode(query, doc.text);
        scores.push({ id: doc.id, score });
      } catch {
        // Documento inválido (ex: texto vazio) → score 0
        scores.push({ id: doc.id, score: 0 });
      }
    }

    // Ordena por score decrescente
    scores.sort((a, b) => b.score - a.score);

    return scores;
  }

  /** true se o serviço está pronto para rerankear */
  get isReady(): boolean {
    return this.ready;
  }

  /** Mensagem de erro da inicialização, ou null */
  get error(): string | null {
    return this.initError;
  }

  // ── Private: Init ───────────────────────────────────────────────

  private async _doInit(): Promise<void> {
    try {
      // Dynamic import — falha se @xenova/transformers não instalado
      const { pipeline } = await import("@xenova/transformers");

      // Cross-encoder usa pipeline "text-classification"
      // O modelo ms-marco-MiniLM-L-6-v2 classifica se documento é relevante
      const pipe = await pipeline(
        "text-classification",
        this.config.model,
        {
          progress_callback: undefined, // silencioso
        }
      );

      this.pipeline = pipe;
      this.ready = true;
    } catch (err) {
      this.initError = `Failed to load reranker model: ${(err as Error).message}`;
    }
  }

  // ── Private: Cross-encode ───────────────────────────────────────

  /**
   * Cross-encode: avalia relevância de um documento para a query.
   *
   * No modelo ms-marco, o input é query + documento concatenados
   * com [SEP]. O output é um score de relevância.
   */
  private async crossEncode(
    query: string,
    document: string
  ): Promise<number> {
    if (!this.pipeline) throw new Error("Reranker not initialized");

    const pipe = this.pipeline as {
      (text: string): Promise<Array<{ label: string; score: number }>>;
    };

    // Formato padrão para cross-encoders: query [SEP] document
    const input = `${query} [SEP] ${document}`;

    const results = await pipe(input);

    // ms-marco retorna logits para classes (ex: "RELEVANT", "NOT_RELEVANT")
    // A classe com maior score é a predição
    // Normalizamos para score 0-1 usando o score da classe positiva
    if (results.length === 1) {
      // Única classe: score direto
      return results[0].score;
    }

    // Múltiplas classes: procura por label positivo (RELEVANT, LABEL_1, etc.)
    const positive = results.find(
      (r) =>
        r.label.toLowerCase().includes("relevant") ||
        r.label === "LABEL_1" ||
        r.label === "1"
    );

    if (positive) return positive.score;

    // Fallback: maior score entre todas as classes
    return Math.max(...results.map((r) => r.score));
  }
}
