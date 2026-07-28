/**
 * EmbeddingService — Geração de embeddings via modelo local ou API fallback.
 *
 * ADR-005: Modelo all-MiniLM-L6-v2 (384 dims, ~80MB), roda 100% local.
 * ADR-008: Usa @xenova/transformers (WASM/ONNX), sem API keys.
 *
 * Fallback: se modelo local falhar e VECTOR_API_KEY estiver disponível,
 * usa embeddings API do OpenRouter (custo ~$0.0001/1K tokens).
 *
 * Arquitetura: lazy init — modelo só é baixado/carregado na primeira chamada.
 */

// ── Tipos ───────────────────────────────────────────────────────────────

export interface EmbeddingServiceConfig {
  /** Modelo de embedding. Default: "all-MiniLM-L6-v2" */
  model: string;
  /** Dimensão do embedding. Default: 384 */
  dimension: number;
  /** Normalizar vetores para comprimento unitário (cosine similarity → dot product) */
  normalize: boolean;
  /** Timeout para download do modelo em ms. Default: 30000 */
  modelDownloadTimeoutMs: number;
  /** API key para fallback (OpenRouter). Se não informada, fallback desabilitado. */
  apiKey?: string;
  /** Se true, tenta API antes do backend local. Default: false */
  preferApi: boolean;
  /** Base URL para API de embeddings (OpenAI-compatível). Default: OpenRouter */
  apiBaseUrl: string;
  /** Modelo API para fallback. Default: "openai/text-embedding-3-small" */
  apiModel: string;
}

const DEFAULTS: EmbeddingServiceConfig = {
  model: "all-MiniLM-L6-v2",
  dimension: 384,
  normalize: true,
  modelDownloadTimeoutMs: 30_000,
  apiBaseUrl: "https://openrouter.ai/api/v1",
  apiModel: "openai/text-embedding-3-small",
  preferApi: false,
};

// ── EmbeddingService ────────────────────────────────────────────────────

export class EmbeddingService {
  private pipeline: unknown = null;
  private ready = false;
  private initError: string | null = null;
  private initPromise: Promise<void> | null = null;
  private backend: "local" | "api" | "none" = "none";
  private readonly config: EmbeddingServiceConfig;

  constructor(config: Partial<EmbeddingServiceConfig> = {}) {
    this.config = { ...DEFAULTS, ...config };
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Inicializa o serviço (lazy, chamado na primeira embed). Thread-safe. */
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

  /** Gera embedding para texto único. */
  async embed(text: string): Promise<Float32Array> {
    await this.initialize();
    if (!this.ready) throw new Error(`EmbeddingService not ready: ${this.initError}`);

    if (this.backend === "local") {
      return this.embedLocal(text);
    }
    if (this.backend === "api") {
      return this.embedApi(text);
    }
    throw new Error("EmbeddingService: no backend available");
  }

  /**
   * Gera embeddings para lote de textos.
   * Backend local: pipeline aceita array (mais eficiente).
   * Backend API: processa em lotes de 20 (limite típico de API).
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.initialize();
    if (!this.ready) throw new Error(`EmbeddingService not ready: ${this.initError}`);

    if (texts.length === 0) return [];

    if (this.backend === "local") {
      return this.embedBatchLocal(texts);
    }
    if (this.backend === "api") {
      return this.embedBatchApi(texts);
    }
    throw new Error("EmbeddingService: no backend available");
  }

  /** true se o serviço está pronto para gerar embeddings */
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
        this.initError = "API embedding backend failed";
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
        this.initError = "API embedding backend failed";
      }
    }

    this.initError = "No embedding backend available. Install @xenova/transformers or set VECTOR_API_KEY.";
    this.backend = "none";
  }

  // ── Private: Local backend ──────────────────────────────────────

  private async initLocal(): Promise<void> {
    // Dynamic import — falha se @xenova/transformers não instalado
    const { pipeline, env } = await import("@xenova/transformers");

    // Configura cache local
    env.cacheDir = undefined; // usa default (~/.cache/huggingface)
    env.localModelPath = undefined;

    const pipe = await pipeline("feature-extraction", this.config.model, {
      progress_callback: undefined, // silencioso em produção
    });

    this.pipeline = pipe;
  }

  private async embedLocal(text: string): Promise<Float32Array> {
    const pipe = this.pipeline as {
      (text: string, opts: Record<string, unknown>): Promise<{ data: Float32Array }>;
    };
    const result = await pipe(text, {
      pooling: "mean",
      normalize: this.config.normalize,
    });
    return result.data;
  }

  private async embedBatchLocal(texts: string[]): Promise<Float32Array[]> {
    const pipe = this.pipeline as {
      (texts: string[], opts: Record<string, unknown>): Promise<{ data: Float32Array }>;
    };
    // Pipeline aceita array diretamente (mais eficiente que N chamadas)
    const result = await pipe(texts, {
      pooling: "mean",
      normalize: this.config.normalize,
    });
    // result.data é Float32Array com todos os embeddings concatenados
    const dim = this.config.dimension;
    const embeddings: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      embeddings.push(result.data.slice(i * dim, (i + 1) * dim));
    }
    return embeddings;
  }

  // ── Private: API fallback ───────────────────────────────────────

  private async embedApi(text: string): Promise<Float32Array> {
    const response = await fetch(`${this.config.apiBaseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.apiModel,
        input: text,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Embedding API error ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding: number[] }>;
    };
    const emb = data.data?.[0]?.embedding;
    if (!emb) throw new Error("Embedding API: no embedding in response");

    return new Float32Array(emb);
  }

  private async embedBatchApi(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    // Processa em lotes para respeitar limites da API
    const batchSize = 20;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await fetch(`${this.config.apiBaseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.apiModel,
          input: batch,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Embedding API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        data?: Array<{ embedding: number[]; index: number }>;
      };
      const embeddings = data.data ?? [];
      // Ordena por index para manter ordem do batch
      embeddings.sort((a, b) => a.index - b.index);
      for (const item of embeddings) {
        results.push(new Float32Array(item.embedding));
      }
    }
    return results;
  }
}

// ── Utilidades ──────────────────────────────────────────────────────────

/** Distância de cosseno entre dois vetores normalizados (dot product) */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // assume vetores normalizados → dot product = cosine similarity
}

/** Normaliza vetor in-place para comprimento unitário */
export function normalizeVector(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}
