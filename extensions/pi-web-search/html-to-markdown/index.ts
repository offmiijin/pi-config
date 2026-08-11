/**
 * HTML → Markdown (pi-web-search) — conversor.
 *
 * Fase 1 — núcleo CommonMark seguro:
 *   `htmlToMarkdown()` é o ponto único de entrada; o pipeline do `web_fetch`
 *   grava páginas HTML como `.md` por meio dele.
 *
 *   Implementação atual: sanitize mínimo por seletor (tags de ruído/execução)
 *   + renderer por tag (títulos, parágrafos, listas, citações, código,
 *   ênfase, links, imagens, mídia) + normalização leve de saída.
 *   Fases seguintes: sanitize completo (Fase 2), tabelas GFM (Fase 3),
 *   formulários (Fase 4), conteúdo editorial (Fase 5), obsoletas (Fase 6).
 */

import * as cheerio from "cheerio";
import { ALLOWED_PROTOCOLS, KEPT_ATTRIBUTES } from "./types";
import type { HtmlToMarkdownOptions, HtmlToMarkdownResult } from "./types";
import { render } from "./renderer";

// Re-exporta o contrato (constantes de regras globais + tipos)
export { ALLOWED_PROTOCOLS, KEPT_ATTRIBUTES };
export type {
	HtmlToMarkdownOptions,
	HtmlToMarkdownResult,
	MarkdownEscapeContext,
} from "./types";

/** Elementos removidos por seletor antes do renderer (ruído/execução + roles). */
const REMOVED_SELECTOR =
	"script, style, noscript, svg, iframe, " +
	"nav, footer, header, " +
	'[role="navigation"], [role="banner"], [role="contentinfo"]';

/**
 * Converte HTML em Markdown seguro (CommonMark).
 *
 * Invariantes do contrato:
 *   - sem HTML bruto na saída
 *   - sem URLs executáveis (protocolos fora da whitelist viram texto/removem-se)
 *   - sem conteúdo de tags removidas
 */
export function htmlToMarkdown(
	html: string,
	options: HtmlToMarkdownOptions,
): HtmlToMarkdownResult {
	const $ = cheerio.load(html);
	// Sanitize mínimo (Fase 2 completa: atributos, hidden, escolha de conteúdo)
	$(REMOVED_SELECTOR).remove();

	const markdown = normalize(
		render($, {
			baseUrl: options.baseUrl,
			allowedProtocols: options.allowedProtocols ?? ALLOWED_PROTOCOLS,
		}),
	);

	return { markdown, baseUrl: options.baseUrl };
}

/** Normalização mínima de saída (Fase 2 completa: markdown-normalizer). */
function normalize(md: string): string {
	return md
		.replace(/\n{3,}/g, "\n\n") // máx. uma linha em branco entre blocos
		.trim();
}
