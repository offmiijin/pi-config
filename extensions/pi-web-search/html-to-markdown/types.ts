/**
 * HTML → Markdown (pi-web-search) — contrato do conversor.
 *
 * Define entrada/saída pública, contextos de escape e regras globais. Os
 * módulos por trás de `htmlToMarkdown()` são:
 * módulos: sanitize, url-resolver, renderer e markdown-normalizer.
 */

/**
 * Protocolos aceitos em `href`/`src` (regra global).
 * Qualquer outro (`javascript:`, `vbscript:`, `data:`, `file:`, ...) é
 * descartado — o atributo nunca vira link/imagem no Markdown.
 */
export const ALLOWED_PROTOCOLS = ["https:", "http:", "mailto:", "tel:"] as const;

/**
 * Atributos preservados pelo conversor (whitelist — regra global).
 * Todo o resto (style, class, id, on*, data-*, aria-*, ...) é ignorado.
 */
export const KEPT_ATTRIBUTES = [
	"href",
	"src",
	"alt",
	"title",
	"start",
	"reversed",
	"type",
	"datetime",
	"cite",
	"colspan",
	"rowspan",
	"checked",
	"selected",
	"value",
	"label",
] as const;

/**
 * Contextos de escape do Markdown usados pelo renderer.
 * Cada contexto protege contra a sintaxe que o conteúdo original poderia
 * introduzir acidentalmente (ex.: `#` no início de um título, `|` em célula).
 */
export type MarkdownEscapeContext =
	/** corpo de parágrafo, lista, blockquote, figcaption */
	| "text"
	/** texto de título — prefixo `#` no início da linha */
	| "heading"
	/** texto visível de um link */
	| "link-text"
	/** URL de destino de um link/imagem */
	| "link-url"
	/** alt de imagem */
	| "image-alt"
	/** código inline — delimitador de backtick */
	| "inline-code"
	/** bloco de código cercado — fence */
	| "fenced-code"
	/** célula de tabela GFM — pipe sensível */
	| "table-cell";

export interface HtmlToMarkdownOptions {
	/** URL final da página (após redirects) — base para resolver links relativos. */
	baseUrl: string;
	/** Protocolos aceitos em href/src (padrão: ALLOWED_PROTOCOLS). */
	allowedProtocols?: readonly string[];
}

export interface HtmlToMarkdownResult {
	/** Markdown gerado — CommonMark seguro, UTF-8, sem HTML bruto. */
	markdown: string;
	/** URL final usada como base de resolução (espelho da entrada). */
	baseUrl: string;
}
