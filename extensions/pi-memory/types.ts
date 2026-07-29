/**
 * Tipos e interfaces da extensão pi-memory.
 */

// ── Memory ─────────────────────────────────────────────────────────────

export type MemoryType = "preference" | "decision" | "lesson" | "fact" | "pattern";

export type MemoryScope = "project" | "user" | "session" | "global";

export interface Memory {
  id: string;
  text: string;
  embedding: Float32Array | null; // 384 dims (all-MiniLM-L6-v2)
  type: MemoryType;
  scope: MemoryScope;
  tags: string[]; // ex: ["#preference", "#pnpm"]
  confidence: number; // 0.0 – 1.0
  timestamp: number; // unix ms
  last_accessed: number; // unix ms
  access_count: number;
  source_ids: string[]; // observation IDs que geraram esta memória
  superseded_by: string | null;
  pinned: boolean;
  project_id: string;
  content_hash: string; // SHA256
}

// ── RawObservation (ADR-001) ───────────────────────────────────────────

export type ObservationType = "tool_result" | "user_prompt";

export interface RawObservation {
  id: string;
  session_id: string;
  project_id: string;
  timestamp: number;
  type: ObservationType;
  tool_name: string | null;
  input_json: string | null; // JSON.stringify do input
  outcome: "success" | "error";
  content_preview: string; // primeiros 2KB do output
  error_preview: string | null; // primeiros 500B do stderr
  file_paths: string[]; // arquivos afetados
  ttl: number; // timestamp de expiração (+7 dias)
  extracted: boolean; // N2 extraiu fatos?
}

// ── ExtractedFact ──────────────────────────────────────────────────────

export interface ExtractedFact {
  text: string;
  type: MemoryType;
  scope: MemoryScope;
  tags: string[];
  confidence: number;
  source_observation_ids: string[];
}

// ── Config ─────────────────────────────────────────────────────────────

export interface PiMemoryConfig {
  /** Caminho base para dados de memória. Default: ~/.pi/agent/memory */
  data_dir: string;

  /** Desabilitar memória (flag --no-memory) */
  disabled: boolean;

  /** TTL de observações brutas em ms. Default: 7 dias */
  observation_ttl_ms: number;

  /** Tamanho máximo do buffer de observações antes de flush forçado */
  buffer_max_size: number;

  /** Intervalo de flush do buffer em ms */
  buffer_flush_interval_ms: number;

  /** Máximo de memórias injetadas no contexto */
  max_injected_memories: number;

  /** Tamanho máximo do bloco de memória injetado em bytes */
  max_injection_bytes: number;

  /** Threshold de confiança para injeção automática */
  injection_confidence_threshold: number;

  /** Nível de extração ativo: "none" | "regex" | "llm" | "kg" */
  extraction_level: "none" | "regex" | "llm" | "kg";

  /** Configuração do LLM para extração N3 */
  llm_extraction: {
    enabled: boolean;
    model: string; // ex: "gpt-4o-mini"
    timeout_ms: number;
    /** A cada quantas observações não extraídas dispara batch LLM */
    sweep_observation_threshold: number;
    /** Tempo máximo de espera para disparar batch parcial (ms) */
    sweep_interval_ms: number;
    /** Intervalo do SweepConsolidator (decay/pruning) em ms */
    sweep_consolidator_interval_ms: number;
    /** API key (LLM_API_KEY env var) */
    apiKey?: string;
  };

  /** Configuração de consolidação */
  consolidation: {
    dedup_enabled: boolean;
    decay_enabled: boolean;
    decay_days: number; // dias sem acesso para iniciar decay
    decay_factor: number; // multiplicador (ex: 0.9)
    pruning_enabled: boolean;
    pruning_confidence_threshold: number;
    pruning_age_days: number;
  };

  /** Configuração de retrieval */
  retrieval: {
    bm25_enabled: boolean;
    vector: {
      local: { enabled: boolean };
      api: { enabled: boolean; model: string };
    };
    hybrid_enabled: boolean;
    reranker: {
      local: { enabled: boolean };
      api: { enabled: boolean; model: string };
    };
    default_top_k: number;
  };
}

export const DEFAULT_CONFIG: PiMemoryConfig = {
  data_dir: "", // preenchido em runtime: ~/.pi/agent/memory
  disabled: false,
  observation_ttl_ms: 7 * 24 * 60 * 60 * 1000,
  buffer_max_size: 100,
  buffer_flush_interval_ms: 30_000,
  max_injected_memories: 5,
  max_injection_bytes: 4 * 1024, // 4KB
  injection_confidence_threshold: 0.6,
  extraction_level: "llm",
  llm_extraction: {
    enabled: false,
    model: "mistralai/mistral-nemo",
    timeout_ms: 5_000,
    sweep_observation_threshold: 100,
    sweep_interval_ms: 30_000,
    /** Intervalo do SweepConsolidator em ms (default: 30 min) */
    sweep_consolidator_interval_ms: 1_800_000,
  },
  consolidation: {
    dedup_enabled: true,
    decay_enabled: false,
    decay_days: 7,
    decay_factor: 0.9,
    pruning_enabled: true,
    pruning_confidence_threshold: 0.1,
    pruning_age_days: 30,
  },
  retrieval: {
    bm25_enabled: true,
    vector: {
      local: { enabled: false },
      api: { enabled: false, model: "openai/text-embedding-3-small" },
    },
    hybrid_enabled: false,
    reranker: {
      local: { enabled: false },
      api: { enabled: false, model: "cohere/rerank-4-pro" },
    },
    default_top_k: 10,
  },
};

// ── Retrieval ──────────────────────────────────────────────────────────

export interface RetrievalResult {
  memory: Memory;
  score: number; // 0.0 – 1.0
  strategy: "bm25" | "vector" | "hybrid";
}

// ── Memory Gateway (ADR-006) ─────────────────────────────────────────

export type GatewayDecision = "KNOWN" | "PRIOR" | "NONE";

// ── Stat counters ──────────────────────────────────────────────────────

export interface MemoryStats {
  total_memories: number;
  total_observations: number;
  pending_extraction: number;
  expired_observations: number;
  by_type: Record<MemoryType, number>;
  by_scope: Record<MemoryScope, number>;
  avg_confidence: number;
  pinned_count: number;
  operations: {
    captures: number;
    extractions_n2: number;
    extractions_n3: number;
    consolidations_n2: number;
    retrievals: number;
    injections: number;
  };
  kv_cache_stable: boolean;
  kv_cache_age_ms: number;
  kv_cache_turns_since_rebuild: number;
  gateway_decisions: Record<string, number>;
}
