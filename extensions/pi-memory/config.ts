/**
 * pi-memory — Configuração da extração (Fase 3).
 *
 * Modelo dedicado e FIXO para extração — não herda o modelo interativo da
 * sessão (mudaria com /model). Meio-termo de custo/qualidade: modelo forte
 * com prompt curado e caching, reasoning médio. O modelo efetivo e a versão
 * do prompt ficam gravados no job para auditoria.
 */

/** Provider + id do modelo de extração (resolvido via modelRegistry.find). */
export const EXTRACTION_MODEL_PROVIDER = "opencode-go";
export const EXTRACTION_MODEL_ID = "deepseek-v4-flash";

export const EXTRACTION_REASONING = "medium";
export const EXTRACTION_CACHE_RETENTION = "default";

/** Orçamentos do prompt de extração (mapping Fase 3, seção 3.4). */
export const EXTRACTION_MAX_EVIDENCE_TOKENS = 18_000;
export const EXTRACTION_MAX_MEMORY_CONTEXT_TOKENS = 5_000;

/** Versão do prompt — jobs gravam; incremente quando o prompt mudar. */
export const EXTRACTION_PROMPT_VERSION = 1;
