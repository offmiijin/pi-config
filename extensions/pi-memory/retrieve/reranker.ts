/**
 * RerankerService — Cross-encoder reranker, ADR-005, Fase 2.5.
 *
 * Dois backends (ordem de prioridade):
 *   1. LOCAL: cross-encoder ms-marco-MiniLM-L-6-v2 via @xenova/transformers
 *   2. API:   cohere/rerank-4-pro via OpenRouter (fallback)
 *
 * Cross-encoder processa o par (query, document) em conjunto — mais lento que
 * bi-encoder (~5ms/par local, ~200ms/API) mas muito mais preciso.
 *
 * ADR-005: aplicado ao top-20 do RRF fusion, reduz para top-10 final.
 * ADR-008: modelo local ~80MB; API ~$0.001/1K documentos.
 *
 * Graceful degradation:
 *   - Sem @xenova/transformers E sem API key → reranker skipped
 *   - Local falha → tenta API (se apiKey disponível)
 *   - Ambos falham → reranker skipped (HybridRetriever usa RRF puro)
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
  // ── Local ──────────────────────────────────────────────────────
  /** Modelo cross-encoder local. Default: Xenova/ms-marco-MiniLM-L-6-v2 */
  model: string;
  /** Timeout de download do modelo em ms. Default: 30000 */
  modelDownloadTimeoutMs: number;

  // ── API fallback ───────────────────────────────────────────────
  /** API key do OpenRouter para fallback. Se vazia, fallback desabilitado. */
  apiKey?: string;
  /** Base URL da API (OpenRouter). Default: https://openrouter.ai/api/v1 */
  apiBaseUrl: string;
  /** Modelo de rerank via API. Default: cohere/rerank-4-pro */
  apiModel: string;
  /** Timeout da chamada API em ms. Default: 5000 */
  apiTimeoutMs: number;

  // ── Geral ──────────────────────────────────────────────────────
  /** Máximo de documentos por batch. Default: 20 */
  maxBatchSize: number;
  /** Se true, tenta API antes do backend local. Default: false */
  preferApi: boolean;
}

const DEFAULTS: RerankerConfig = {
  model: "Xenova/ms-marco-MiniLM-L-6-v2",
  modelDownloadTimeoutMs: 30_000,
  apiBaseUrl: "https://openrouter.ai/api/v1",
  apiModel: "cohere/rerank-4-pro",
  apiTimeoutMs: 5_000,
  maxBatchSize: 20,
  preferApi: false,
};

// ── RerankerService ────────────────────────────────────────────────────

export class RerankerService {
  private pipeline: unknown = null;
  private ready = false;
  private initError: string | null = null;
  private initPromise: Promise<void> | null = null;
  private backend: "local" | "api" | "none" = "none";
  private readonly config: RerankerConfig;

  constructor(config: Partial<RerankerConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Inicializa o reranker (lazy, chamado no primeiro rerank). Thread-safe. */
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

    if (this.backend === "local") {
      return this.rerankLocal(query, batch);
    }
    if (this.backend === "api") {
      return this.rerankApi(query, batch);
    }
    throw new Error("RerankerService: no backend available");
  }

  /** true se o serviço está pronto */
  get isReady(): boolean {
    return this.ready;
  }

  /** Backend em uso: "local", "api" ou "none" */
  get activeBackend(): "local" | "api" | "none" {
    return this.backend;
  }

  /** Mensagem de erro da inicialização, ou null */
  get error(): string | null {
    return this.initError;
  }

  // ── Private: Init ───────────────────────────────────────────────

  private async _doInit(): Promise<void> {
    if (this.config.preferApi && this.config.apiKey) {
      // Prioridade: API
      try {
        this.backend = "api";
        this.ready = true;
        return;
      } catch {
        // Silencioso
      }
    }

    // Tenta backend local
    try {
      await this.initLocal();
      this.backend = "local";
      this.ready = true;
      return;
    } catch {
      // Silencioso
    }

    // Fallback: API (se não tentou antes)
    if (!this.config.preferApi && this.config.apiKey) {
      try {
        this.backend = "api";
        this.ready = true;
        return;
      } catch {
        // continua
      }
    }

    this.initError =
      "No reranker backend available. Install @xenova/transformers or set OPENROUTER_API_KEY.";
    this.backend = "none";
  }

  // ── Private: Local backend ──────────────────────────────────────

  private async initLocal(): Promise<void> {
    const { pipeline } = await import("@xenova/transformers");

    const pipe = await pipeline("text-classification", this.config.model, {
      progress_callback: undefined,
    });

    this.pipeline = pipe;
  }

  private async rerankLocal(
    query: string,
    documents: RerankerDocument[]
  ): Promise<RerankerResult[]> {
    const scores: RerankerResult[] = [];
    for (const doc of documents) {
      try {
        const score = await this.crossEncode(query, doc.text);
        scores.push({ id: doc.id, score });
      } catch {
        scores.push({ id: doc.id, score: 0 });
      }
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
  }

  private async crossEncode(
    query: string,
    document: string
  ): Promise<number> {
    if (!this.pipeline) throw new Error("Reranker not initialized");

    const pipe = this.pipeline as {
      (text: string): Promise<Array<{ label: string; score: number }>>;
    };

    const input = `${query} [SEP] ${document}`;
    const results = await pipe(input);

    if (results.length === 1) {
      return results[0].score;
    }

    const positive = results.find(
      (r) =>
        r.label.toLowerCase().includes("relevant") ||
        r.label === "LABEL_1" ||
        r.label === "1"
    );

    if (positive) return positive.score;
    return Math.max(...results.map((r) => r.score));
  }

  // ── Private: API fallback ───────────────────────────────────────

  /**
   * Rerank via OpenRouter usando Cohere rerank API.
   *
   * Endpoint: POST /rerank
   * Modelo: cohere/rerank-4-pro
   * Latência: ~200-500ms
   */
  private async rerankApi(
    query: string,
    documents: RerankerDocument[]
  ): Promise<RerankerResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.apiTimeoutMs
    );

    try {
      const resp = await fetch(`${this.config.apiBaseUrl}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.apiModel,
          query,
          documents: documents.map((d) => d.text),
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(
          `Rerank API error ${resp.status}: ${body.slice(0, 200)}`
        );
      }

      const data = (await resp.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };

      const results = data.results ?? [];

      // Mapeia de volta para IDs e normaliza scores
      return results
        .map((r) => ({
          id: documents[r.index]?.id ?? "unknown",
          // Cohere scores já vêm normalizados 0-1
          score: Math.max(0, Math.min(1, r.relevance_score)),
        }))
        .sort((a, b) => b.score - a.score);
    } finally {
      clearTimeout(timeout);
    }
  }
}
