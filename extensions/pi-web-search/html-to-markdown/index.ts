/**
 * HTML → Markdown (pi-web-search) — conversor.
 *
 * Pipeline: contrato, renderização CommonMark, sanitização DOM, escolha do
 * conteúdo principal, normalização, tabelas, formulários e tags obsoletas.
 */

import * as cheerio from "cheerio";
import { ALLOWED_PROTOCOLS, KEPT_ATTRIBUTES } from "./types";
import type { HtmlToMarkdownOptions, HtmlToMarkdownResult } from "./types";
import { render } from "./renderer";
import { sanitizeDocument, sanitizeAttributes, selectContentRoot } from "./sanitize";
import { normalizeMarkdown } from "./normalizer";

// Re-exporta o contrato (constantes de regras globais + tipos)
export { ALLOWED_PROTOCOLS, KEPT_ATTRIBUTES };
export type {
	HtmlToMarkdownOptions,
	HtmlToMarkdownResult,
	MarkdownEscapeContext,
} from "./types";

/** Elementos removidos por seletor antes da sanitização (ruído + roles). */
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
 *   - sem conteúdo de tags removidas ou ocultas
 *   - só o conteúdo principal quando houver candidato claro
 */
export function htmlToMarkdown(
	html: string,
	options: HtmlToMarkdownOptions,
): HtmlToMarkdownResult {
	const $ = cheerio.load(html);
	// Ruído por seletor — antes de sanitizar atributos (usa roles)
	$(REMOVED_SELECTOR).remove();
	// Sanitização estrutural: comentários, doctype, hidden, nós vazios
	sanitizeDocument($);
	// Escolha de conteúdo: article → main → [role="main"] → body
	const root = selectContentRoot($);
	// Atributos fora da whitelist removidos (class language-* preservada em code)
	sanitizeAttributes($);

	const markdown = normalizeMarkdown(
		render(
			$,
			{
				baseUrl: options.baseUrl,
				allowedProtocols: options.allowedProtocols ?? ALLOWED_PROTOCOLS,
			},
			root,
		),
	);

	return { markdown, baseUrl: options.baseUrl };
}
