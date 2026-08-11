/**
 * HTML → Markdown (pi-web-search) — conversor.
 *
 * Fase 0 — contrato + pipeline:
 *   `htmlToMarkdown()` é o ponto único de entrada. O pipeline do `web_fetch`
 *   grava páginas HTML como `.md` por meio dele (antes: `.txt` via extractText).
 *
 *   Implementação atual: placeholder equivalente ao antigo extractText() —
 *   texto seguro (sem HTML bruto, sem tags removidas), ainda sem estrutura.
 *   As fases seguintes substituem o corpo por:
 *     1. sanitize            — remove tags/atributos perigosos (whitelist)
 *     2. url-resolver        — resolve links relativos contra baseUrl e valida protocolos
 *     3. renderer            — tags → blocos e inline Markdown
 *     4. markdown-normalizer — quebras, listas, blocos e escape por contexto
 */

import * as cheerio from "cheerio";
import { ALLOWED_PROTOCOLS, KEPT_ATTRIBUTES } from "./types";
import type { HtmlToMarkdownOptions, HtmlToMarkdownResult } from "./types";

// Re-exporta o contrato (constantes de regras globais + tipos)
export { ALLOWED_PROTOCOLS, KEPT_ATTRIBUTES };
export type {
	HtmlToMarkdownOptions,
	HtmlToMarkdownResult,
	MarkdownEscapeContext,
} from "./types";

/** Elementos sempre removidos, com descendentes (ruído/execução). */
const REMOVED_SELECTOR =
	"script, style, noscript, svg, iframe, " +
	"nav, footer, header, " +
	'[role="navigation"], [role="banner"], [role="contentinfo"]';

/**
 * Converte HTML em Markdown seguro.
 *
 * Fase 0 (placeholder): remove tags de ruído e normaliza o whitespace.
 * Garante as invariantes do contrato:
 *   - sem HTML bruto na saída
 *   - sem URLs executáveis
 *   - sem conteúdo de tags removidas
 */
export function htmlToMarkdown(
	html: string,
	options: HtmlToMarkdownOptions,
): HtmlToMarkdownResult {
	const markdown = extractSafeText(html);
	return { markdown, baseUrl: options.baseUrl };
}

/** Placeholder do renderer (Fase 1): texto limpo, sem estrutura ainda. */
function extractSafeText(html: string): string {
	const $ = cheerio.load(html);
	$(REMOVED_SELECTOR).remove();
	const body = $("body").length ? $("body") : $.root();
	return body.text().replace(/\s+/g, " ").trim();
}
