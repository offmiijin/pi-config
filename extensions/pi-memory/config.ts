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

export const EXTRACTION_REASONING = "low";
// "medium" NÃO: modelo deepseek-thinking devolve só reasoning sem texto
// final intermitentemente (medido 75% de respostas vazias em prompt real) —
// "low" responde com JSON sempre (4/4) e é o mesmo nível do revisor.
// API de cache aceita apenas none | short | long — "default" era inválido
// (o provider tratava como valor desconhecido e nunca habilitava cache).
export const EXTRACTION_CACHE_RETENTION = "short";

/**
 * Teto de tokens de saída por chamada (extração E revisor). Sem isso o
 * modelo pode gerar até o limite do provider — observado 15.7K output num
 * job real. 4K cobre JSON de candidatos sem inflar o custo.
 */
export const EXTRACTION_MAX_OUTPUT_TOKENS = 4_096;
/**
 * sessionId fixo usado em TODAS as chamadas de extração/revisão: o provider
 * usa este valor como chave do cache de prompt (prompt_cache_key). UUID novo
 * por chamada zerava o cache — retry e prompts subsequentes reutilizam o
 * prefixo estático.
 */
export const EXTRACTION_SESSION_ID = "pi-memory-extraction";

/**
 * Teto de candidatos aceitos por job — mantém os top N por confidence e
 * rejeita o excedente (evita despejo de dezenas de memórias triviais).
 */
export const EXTRACTION_MAX_CANDIDATES_PER_JOB = 8;

/** Orçamentos do prompt de extração (mapping Fase 3, seção 3.4). */
export const EXTRACTION_MAX_EVIDENCE_TOKENS = 18_000;
export const EXTRACTION_MAX_MEMORY_CONTEXT_TOKENS = 5_000;

/** Versão do prompt — jobs gravam; incremente quando o prompt mudar. */
export const EXTRACTION_PROMPT_VERSION = 1;
