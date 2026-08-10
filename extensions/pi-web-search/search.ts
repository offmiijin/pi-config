/**
 * Web Search Extension — Search Orchestrator
 *
 * Cascade: SearXNG (local) → Tavily → Exa → Serper.dev
 * SearXNG tried first because it's local, free, no rate limits.
 * If all fail, returns clear error with setup instructions.
 */

import type { SearchResult, EngineResult } from "./engines";
import { searchSearxng, searchTavily, searchExa, searchSerper } from "./engines";
import { createAbortController } from "./engines";
import {
	getSearxngUrl,
	getSearxngKey,
	getSearxngTargetUrl,
	getConfiguredProviders,
} from "./config";

export type SearchSource = "searxng" | "tavily" | "exa" | "serper";

export interface SearchOutput {
	query: string;
	source: SearchSource;
	results: SearchResult[];
	error?: string;
}

export { SearchResult };
export type { EngineResult };

// ── Probes / validação ────────────────────────────────────────────────────

let searxngReachCache: boolean | null = null;

/** Limpa o cache de alcance do SearXNG (útil para testes). */
export function resetSearxngReachCache(): void {
	searxngReachCache = null;
}

/**
 * SearXNG local responde? (Docker rodando / serviço no host).
 * Cache por processo; timeout curto (3s) para não travar o startup.
 */
export async function isSearxngReachable(signal?: AbortSignal): Promise<boolean> {
	if (searxngReachCache !== null) return searxngReachCache;
	try {
		const { controller, cleanup } = createAbortController(signal, 3000);
		try {
			const res = await fetch(getSearxngTargetUrl(), {
				signal: controller.signal,
				method: "GET",
			});
			searxngReachCache = res.ok;
		} finally {
			cleanup();
		}
	} catch {
		searxngReachCache = false;
	}
	return searxngReachCache;
}

export interface ProviderValidation {
	ok: boolean;
	detail: string;
}

/**
 * Valida uma chave/provider com requisição de teste.
 * - Cloud (serper/exa/tavily): busca real de teste (1 query do plano grátis).
 * - searxng: probe de alcance (local não precisa de chave).
 */
export async function validateProvider(provider: string): Promise<ProviderValidation> {
	switch (provider) {
		case "searxng":
		case "searx": {
			const ok = await isSearxngReachable();
			return ok
				? { ok: true, detail: `SearXNG responde em ${getSearxngTargetUrl()}` }
				: {
						ok: false,
						detail: `SearXNG não responde em ${getSearxngTargetUrl()} — suba o container (docker compose up -d) ou use outra engine`,
				  };
		}
		case "serper":
		case "serper.dev": {
			const r = await searchSerper("web search test", undefined);
			return r.results.length > 0
				? { ok: true, detail: "chave serper.dev válida" }
				: { ok: false, detail: r.error ?? "falha ao validar serper.dev" };
		}
		case "exa": {
			const r = await searchExa("web search test", undefined);
			return r.results.length > 0
				? { ok: true, detail: "chave exa válida" }
				: { ok: false, detail: r.error ?? "falha ao validar exa" };
		}
		case "tavily": {
			const r = await searchTavily("web search test", undefined);
			return r.results.length > 0
				? { ok: true, detail: "chave tavily válida" }
				: { ok: false, detail: r.error ?? "falha ao validar tavily" };
		}
		default:
			return { ok: false, detail: `provider desconhecido: ${provider}` };
	}
}

// ── Cascade ───────────────────────────────────────────────────────────────

/**
 * Search via engine cascade: SearXNG → Tavily → Exa → Serper.dev.
 */
export async function search(
	query: string,
	signal?: AbortSignal,
): Promise<SearchOutput> {
	// 0. SearXNG (local, self-hosted). Tenta quando configurado (URL/chave) OU
	//     quando responde no localhost — o probe (3s, cache por processo) cobre
	//     quem subiu o container (install.sh --searxng, docker compose) sem
	//     precisar configurar URL/chave, e evita o timeout de 10s do
	//     searchSearxng quando o SearXNG não está rodando.
	const searxngConfigured = getSearxngUrl() !== null || getSearxngKey() !== null;
	const searxng =
		searxngConfigured || (await isSearxngReachable(signal))
			? await searchSearxng(query, signal)
			: { results: [] as SearchResult[], error: "SearXNG: não configurado nem acessível em localhost:4000 — pulando" };
	if (searxng.results.length > 0) {
		return { query, source: "searxng", results: searxng.results };
	}

	// 1. Tavily
	const tavily = await searchTavily(query, signal);
	if (tavily.results.length > 0) {
		return {
			query,
			source: "tavily",
			results: tavily.results,
			error: searxng.error ? `SearXNG failed: ${searxng.error}` : undefined,
		};
	}

	// 2. Exa
	const exa = await searchExa(query, signal);
	if (exa.results.length > 0) {
		return {
			query,
			source: "exa",
			results: exa.results,
			error: [searxng.error ? `SearXNG: ${searxng.error}` : null, tavily.error ? `Tavily: ${tavily.error}` : null].filter(Boolean).join(" | "),
		};
	}

	// 3. Serper.dev
	const serper = await searchSerper(query, signal);
	if (serper.results.length > 0) {
		return {
			query,
			source: "serper",
			results: serper.results,
			error: [
				searxng.error ? `SearXNG: ${searxng.error}` : null,
				tavily.error ? `Tavily: ${tavily.error}` : null,
				exa.error ? `Exa: ${exa.error}` : null,
			].filter(Boolean).join(" | "),
		};
	}

	// All failed
	const configured = getConfiguredProviders();
	const errors = [searxng.error, tavily.error, exa.error, serper.error]
		.filter((e): e is string => !!e);
	return {
		query,
		source: "serper",
		results: [],
		error:
			configured.length === 0
				? "Nenhum provedor de busca configurado — web_search sem resultados.\n" +
					"Opções:\n" +
					"  • SearXNG local (grátis): docker compose up -d em extensions/pi-web-search (ou ./install.sh --searxng)\n" +
					"  • API gratuita: /web_search config <tavily|exa|serper> <key> (tavily/exa 1k/mês, serper 2.5k/mês)\n" +
					"  • Env vars: TAVILY_API_KEY, EXA_API_KEY, SERPER_API_KEY, SEARXNG_URL"
				: `All engines failed (configuradas: ${configured.join(", ")}): ${errors.join(" | ")}`,
	};
}
