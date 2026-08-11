/**
 * Renderer HTML → Markdown (pi-web-search).
 *
 * Fase 1 — núcleo CommonMark seguro:
 *   containers, títulos, separadores, parágrafos, blockquote, blocos de
 *   código, listas (aninhadas, start), definições (dl/dt/dd), ênfase
 *   inline, links, imagens e mídia com representação textual, e remoção
 *   integral de tags perigosas. Tabelas (GFM) e formulários nas fases 3-4.
 */

import type { AnyNode, Element, Text } from "domhandler";
import type { CheerioAPI } from "cheerio";
import type { MarkdownEscapeContext } from "./types";
import { resolveUrl } from "./url-resolver";
import { escapeText, inlineCode, escapeUrl, fenceFor } from "./escape";

export interface RenderOptions {
	baseUrl: string;
	allowedProtocols: readonly string[];
	/** contexto de escape herdado para texto puro */
	escapeCtx?: MarkdownEscapeContext;
	/** dentro de <li>: listas aninhadas seguem na mesma linha (tight) */
	inListItem?: boolean;
}

/** Tags renderizadas como bloco (afetam a separação entre filhos). */
const BLOCK_TAGS = new Set([
	"p", "div", "section", "article", "main", "center", "hgroup", "dialog",
	"details", "summary", "blockquote", "pre", "figure", "figcaption",
	"address", "hr", "ul", "ol", "menu", "dir", "dl", "dt", "dd",
	"table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
	"form", "fieldset", "legend", "select", "datalist", "textarea", "optgroup",
	"listing", "xmp", "plaintext",
	"h1", "h2", "h3", "h4", "h5", "h6",
]);

/** Conteúdo de célula que impede tabela GFM (cai no fallback). */
const COMPLEX_CELL_TAGS = new Set([
	"ul", "ol", "menu", "dir", "pre", "blockquote", "table", "dl",
	"figure", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
]);

/** Tags removidas integralmente (com descendentes) — Fase 1.8 + 6. */
const REMOVED_TAGS = new Set([
	"script", "style", "template", "noscript", "iframe", "frame", "frameset",
	"portal", "svg", "math", "canvas", "object", "embed", "applet", "base",
	"link", "meta", "title", "param", "slot",
	"header", "footer", "nav", "aside", "search",
	"keygen", "command", "isindex",
]);

const LIST_TAGS = new Set(["ul", "ol", "menu", "dir"]);

const HEADING_LEVEL: Record<string, number> = {
	h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
};

/** Tags achatadas: apenas o conteúdo interno, sem wrapper Markdown. */
const FLATTEN_TAGS = new Set([
	"span", "bdi", "bdo", "wbr", "small", "big", "u", "mark",
	"cite", "dfn", "abbr", "acronym", "time", "data", "sub", "sup",
	"ruby", "rb", "rtc", "rbc", "ins", "menuitem",
	// Obsoletas (Fase 6)
	"font", "basefont", "tt", "marquee", "blink", "content",
]);

/** Ponto de entrada: renderiza o documento (ou um container selecionado). */
export function render($: CheerioAPI, opts: RenderOptions, rootEl?: AnyNode): string {
	const root = rootEl ?? $.root()[0];
	// Elemento raiz passa pelo dispatch (ex.: article aninhado → separadores ---)
	return isElement(root) ? renderNode($, root, opts) ?? "" : renderChildren($, root, opts);
}

function isElement(n: AnyNode): n is Element {
	return n.type === "tag" || n.type === "script" || n.type === "style";
}

function isBlockNode(n: AnyNode): boolean {
	return isElement(n) && BLOCK_TAGS.has(n.tagName.toLowerCase());
}

function attr($: CheerioAPI, el: Element, name: string): string | undefined {
	return $(el).attr(name);
}

// ---------------------------------------------------------------------------
// Filhos — separação de blocos e espaços inline
// ---------------------------------------------------------------------------

/**
 * Renderiza os filhos de `el`: blocos separados por linha em branco,
 * inline concatenado com colapso de espaço nas fronteiras.
 */
function renderChildren($: CheerioAPI, el: AnyNode | undefined, opts: RenderOptions): string {
	if (!el || !("children" in el)) return "";

	const parts: Array<{ text: string; isBlock: boolean; tag?: string; ws?: boolean }> = [];
	for (const child of el.children) {
		const rendered = renderNode($, child, opts);
		if (rendered === null || rendered === "") continue;
		const isBlock = isBlockNode(child);
		// Texto puro com só whitespace vira espaço inline (nunca quebra <br>)
		if (!isBlock && child.type === "text" && rendered.trim() === "") {
			parts.push({ text: " ", isBlock: false, ws: true });
		} else {
			parts.push({
				text: rendered,
				isBlock,
				tag: isElement(child) ? child.tagName.toLowerCase() : undefined,
			});
		}
	}

	let out = "";
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (!out) {
			out = p.text;
			continue;
		}
		const prev = parts[i - 1];
		if (prev.isBlock || p.isBlock) {
			if (p.ws) continue; // whitespace entre blocos → pula (só whitespace)
			if (opts.inListItem && p.tag && LIST_TAGS.has(p.tag)) {
				out += "\n"; // lista aninhada segue na mesma linha do item (tight)
			} else {
				out += "\n\n";
			}
		}
		out += p.text;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function renderNode($: CheerioAPI, node: AnyNode, opts: RenderOptions): string | null {
	if (node.type === "comment") return null;

	if (node.type === "text") {
		return escapeText((node as Text).data.replace(/\s+/g, " "), opts.escapeCtx ?? "text");
	}

	if (!isElement(node)) return null;
	const tag = node.tagName.toLowerCase();

	if (REMOVED_TAGS.has(tag)) return null;

	// ── Títulos ────────────────────────────────────────────────────────
	const level = HEADING_LEVEL[tag];
	if (level) {
		const text = renderChildren($, node, { ...opts, escapeCtx: "heading" }).trim();
		return text ? `${"#".repeat(level)} ${text}` : null;
	}

	switch (tag) {
		case "hr":
			return "---";

		case "br":
			return "\n";

		// ── Containers transparentes ─────────────────────────────────
		case "html":
		case "body":
		case "main":
		case "section":
		case "div":
		case "center":
		case "hgroup":
		case "dialog":
		case "details":
		case "figure":
		case "map": {
			const t = renderChildren($, node, opts).trim();
			return t || null;
		}

		case "article":
			return renderArticle($, node, opts);

		case "summary": {
			const t = renderChildren($, node, opts).trim();
			return t ? `**${t}**` : null;
		}

		// ── Parágrafos ──────────────────────────────────────────────
		case "p":
		case "address": {
			const t = renderChildren($, node, { ...opts, escapeCtx: "text" }).trim();
			return t ? t : null;
		}

		case "blockquote": {
			const content = renderChildren($, node, opts).trim();
			if (!content) return null;
			return content
				.split("\n")
				.map((l) => (l.trim() === "" ? ">" : `> ${l}`))
				.join("\n");
		}

		case "figcaption": {
			const t = renderChildren($, node, opts).trim();
			return t ? `*${t}*` : null;
		}

		case "pre":
			return renderPre($, node);

		case "ul":
		case "menu":
		case "dir":
			return renderList($, node, opts, false, "");

		case "ol":
			return renderList($, node, opts, true, "");

		case "dl":
			return renderDl($, node, opts);

		case "table":
			return renderTable($, node, opts);

		case "caption": {
			const t = renderChildren($, node, opts).trim();
			return t ? `*${t}*` : null;
		}

		// Estrutura de tabela: tratada por renderTable
		case "thead":
		case "tbody":
		case "tfoot":
		case "tr":
		case "th":
		case "td":
		case "colgroup":
		case "col":
			return null;

		// ── Inline ──────────────────────────────────────────────────
		case "strong":
		case "b": {
			const t = renderChildren($, node, opts).trim();
			return t ? `**${t}**` : null;
		}

		case "em":
		case "i": {
			const t = renderChildren($, node, opts).trim();
			return t ? `*${t}*` : null;
		}

		// Conteúdo editorial (Fase 5): strikethrough GFM
		case "del":
		case "s":
		case "strike": {
			const t = renderChildren($, node, opts).trim();
			return t ? `~~${t}~~` : null;
		}

		case "code":
		case "kbd":
		case "samp":
		case "var": {
			const c = inlineCode($(node).text());
			return c || null;
		}

		case "q": {
			const t = renderChildren($, node, opts).trim();
			return t ? `"${t}"` : null;
		}

		case "a":
			return renderLink($, node, opts);

		case "area":
			return renderArea($, node, opts);

		case "img":
			return renderImage($, node, opts);

		case "picture":
			return renderPicture($, node, opts);

		case "audio":
		case "video":
			return renderMedia($, node, opts);

		case "source":
		case "track":
			return null;

		// ── Formulários (Fase 4) ────────────────────────────────────
		case "form":
		case "fieldset": {
			const t = renderChildren($, node, opts).trim();
			return t || null;
		}

		case "legend":
		case "label": {
			const t = renderChildren($, node, opts).trim();
			return t ? `**${t}**` : null;
		}

		case "input":
			return renderInput($, node);

		case "button": {
			const t = renderChildren($, node, opts).trim();
			return t || null;
		}

		case "select":
		case "datalist":
			return renderSelect($, node);

		case "optgroup":
			return renderOptgroup($, node);

		case "option":
			return null; // tratado dentro de select/datalist

		case "textarea":
		case "listing":
		case "xmp":
		case "plaintext":
			return renderRawTextBlock($, node);

		case "output": {
			const t = renderChildren($, node, opts).trim();
			return t || null;
		}

		case "progress":
		case "meter": {
			const t = renderChildren($, node, opts).trim();
			if (t) return t;
			const v = attr($, node, "value");
			return v !== undefined && v.trim() !== "" ? escapeText(v.trim()) : null;
		}

		case "rt":
		case "rp":
			return null;

		default:
			if (FLATTEN_TAGS.has(tag)) return renderChildren($, node, opts);
			// Tag desconhecida: só os filhos renderizados, sem wrapper
			return renderChildren($, node, opts);
	}
}

// ---------------------------------------------------------------------------
// Blocos específicos
// ---------------------------------------------------------------------------

/** Bloco de código cercado; linguagem de `class="language-*"` quando segura. */
function renderPre($: CheerioAPI, node: Element): string | null {
	const codeEl = $(node).find("code").first();
	const content = (codeEl.length ? codeEl.text() : $(node).text()).replace(/\n+$/, "");
	if (!content.trim()) return null;
	const lang =
		codeEl.length
			? (codeEl.attr("class")?.match(/(?:^|\s)language-([a-zA-Z0-9_+-]+)/)?.[1] ?? "")
			: "";
	return `${fenceFor(content)}${lang}\n${content}\n${fenceFor(content)}`;
}

function parseStart(v: string | undefined): number {
	const n = parseInt(v ?? "", 10);
	return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Lista (ul/ol/menu/dir). `indent` acumula a indentação dos níveis pai;
 * cada nível re-indenta o conteúdo do item em `pad` (largura do marcador).
 */
function renderList(
	$: CheerioAPI,
	node: Element,
	opts: RenderOptions,
	ordered: boolean,
	indent: string,
): string | null {
	const items = (node.children ?? []).filter(
		(c): c is Element => isElement(c) && c.tagName.toLowerCase() === "li",
	);
	if (items.length === 0) return null;

	const start = ordered ? parseStart(attr($, node, "start")) : 1;
	const lines: string[] = [];
	let n = start;

	for (const li of items) {
		const marker = ordered ? `${n}. ` : "- ";
		n += 1;
		const pad = indent + " ".repeat(marker.length);
		const content = renderChildren($, li, { ...opts, inListItem: true }).trim();
		if (!content) continue; // li vazio não gera item

		const bodyLines = content.split("\n");
		// Item sem texto (só lista aninhada): lista aninhada na linha seguinte
		if (/^([-+*]|\d+\.)\s/.test(bodyLines[0] ?? "")) {
			const indented = bodyLines.map((l) => (l === "" ? "" : pad + l)).join("\n");
			lines.push(`${indent}${marker.trimEnd()}\n${indented}`);
		} else {
			const indented = bodyLines
				.map((l, i) => (i === 0 ? l : l === "" ? "" : pad + l))
				.join("\n");
			lines.push(`${indent}${marker}${indented}`);
		}
	}
	return lines.join("\n");
}

/** Lista de definições: `**termo**` + definição na linha seguinte. */
function renderDl($: CheerioAPI, node: Element, opts: RenderOptions): string | null {
	let out = "";
	let first = true;
	for (const child of node.children ?? []) {
		if (!isElement(child)) continue;
		const tag = child.tagName.toLowerCase();
		if (tag === "dt") {
			const t = renderChildren($, child, opts).trim();
			if (!t) continue;
			if (!first) out += "\n\n";
			out += `**${t}**`;
			first = false;
		} else if (tag === "dd") {
			const c = renderChildren($, child, opts).trim();
			if (!c) continue;
			out += `\n${c}`;
			first = false;
		}
	}
	return out || null;
}

/**
 * <article>: container transparente; com <article> aninhado (direto), os
 * blocos são separados por `---` (Fase 5).
 */
function renderArticle($: CheerioAPI, node: Element, opts: RenderOptions): string | null {
	const kids = (node.children ?? []).filter(isElement);
	const hasNested = kids.some((c) => c.tagName.toLowerCase() === "article");
	if (!hasNested) {
		const t = renderChildren($, node, opts).trim();
		return t || null;
	}

	let out = "";
	let prevBlock = false;
	for (const child of node.children ?? []) {
		const rendered = renderNode($, child, opts);
		if (rendered === null || rendered === "") continue;
		const isBlock = isBlockNode(child);
		const isArticle = isElement(child) && child.tagName.toLowerCase() === "article";
		if (!isBlock && rendered.trim() === "") {
			if (!out || prevBlock) continue; // whitespace em borda de bloco
			out += " ";
			prevBlock = false;
			continue;
		}
		if (out) {
			if (isArticle) out += "\n\n---\n\n";
			else if (prevBlock || isBlock) out += "\n\n";
		}
		out += rendered;
		prevBlock = isBlock;
	}
	return out.trim() || null;
}

// ---------------------------------------------------------------------------
// Tabelas (Fase 3 — GFM com fallback seguro)
// ---------------------------------------------------------------------------

/** Coleta as <tr> diretas da tabela (ignora tabelas aninhadas em células). */
function collectRows($: CheerioAPI, table: Element): Element[] {
	const rows: Element[] = [];
	for (const child of table.children ?? []) {
		if (!isElement(child)) continue;
		const tag = child.tagName.toLowerCase();
		if (tag === "tr") {
			rows.push(child);
		} else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
			for (const sub of child.children ?? []) {
				if (isElement(sub) && sub.tagName.toLowerCase() === "tr") rows.push(sub);
			}
		}
	}
	return rows;
}

/** Células (th/td) diretas de uma linha. */
function collectCells($: CheerioAPI, tr: Element): Element[] {
	const cells: Element[] = [];
	for (const child of tr.children ?? []) {
		if (isElement(child)) {
			const tag = child.tagName.toLowerCase();
			if (tag === "th" || tag === "td") cells.push(child);
		}
	}
	return cells;
}

/** Célula com blocos complexos (listas, código, tabela, ...) → não é GFM. */
function hasComplexContent($: CheerioAPI, cell: Element): boolean {
	let complex = false;
	$(cell)
		.find("*")
		.each((_, el) => {
			if (COMPLEX_CELL_TAGS.has(el.tagName.toLowerCase())) complex = true;
		});
	return complex;
}

/**
 * Tabela GFM quando segura (colunas consistentes, sem rowspan/colspan>1,
 * células simples, cabeçalho explícito ou primeira linha th); senão fallback
 * `**Cabeçalho:** valor`. Nunca emite tabela parcialmente quebrada.
 */
function renderTable($: CheerioAPI, node: Element, opts: RenderOptions): string | null {
	const rows = collectRows($, node);
	if (rows.length === 0) return null;

	const cellsOf = (tr: Element) => collectCells($, tr);
	const isTh = (c: Element) => c.tagName.toLowerCase() === "th";

	// Cabeçalho: <thead> (primeira tr) ou primeira linha toda de <th>
	const isTheadRow = (tr: Element) =>
		tr.parent?.type === "tag" &&
		(tr.parent as Element).tagName.toLowerCase() === "thead";
	let headerIdx = rows.findIndex(isTheadRow);
	if (headerIdx === -1) {
		const first = cellsOf(rows[0]);
		if (first.length > 0 && first.every(isTh)) headerIdx = 0;
	}

	const headerRow = headerIdx >= 0 ? rows[headerIdx] : undefined;
	const dataRows = headerRow ? rows.filter((r) => r !== headerRow) : rows;
	const headerCells = headerRow ? cellsOf(headerRow) : [];

	const allCells = [headerCells, ...dataRows.map(cellsOf)];
	const colCount = headerCells.length || cellsOf(dataRows[0] ?? rows[0]).length;
	if (colCount === 0) return null;

	// Validações para GFM
	const consistent = allCells.every((cells) => cells.length === colCount);
	let spansOk = true;
	let simple = true;
	for (const cells of allCells) {
		for (const c of cells) {
			const rowspan = attr($, c, "rowspan");
			const colspan = attr($, c, "colspan");
			if ((rowspan && rowspan !== "1") || (colspan && colspan !== "1")) spansOk = false;
			if (hasComplexContent($, c)) simple = false;
		}
	}

	const captionEl = (node.children ?? []).find(
		(c) => isElement(c) && c.tagName.toLowerCase() === "caption",
	) as Element | undefined;
	const caption = captionEl ? renderChildren($, captionEl, opts).trim() : "";
	const prefix = caption ? `*${caption}*\n\n` : "";

	if (headerCells.length > 0 && consistent && spansOk && simple) {
		const head = headerCells.map((c) =>
			renderChildren($, c, { ...opts, escapeCtx: "table-cell" }).trim(),
		);
		const body = dataRows.map((tr) =>
			cellsOf(tr).map((c) =>
				renderChildren($, c, { ...opts, escapeCtx: "table-cell" }).trim(),
			),
		);
		const sep = `| ${head.map(() => "---").join(" | ")} |`;
		const lines = [`| ${head.join(" | ")} |`, sep, ...body.map((r) => `| ${r.join(" | ")} |`)];
		return prefix + lines.join("\n");
	}

	// Fallback: **Cabeçalho:** valor (rótulos genéricos sem cabeçalho)
	const labels = headerCells.length
		? headerCells.map((c) => renderChildren($, c, { ...opts, escapeCtx: "text" }).trim())
		: [];
	const groups = dataRows.map((tr) =>
		cellsOf(tr)
			.map((c) => renderChildren($, c, { ...opts, escapeCtx: "text" }).trim())
			.map((v, i) => `**${labels[i] || `Coluna ${i + 1}`}:** ${v}`)
			.join("\n"),
	);
	return prefix + groups.join("\n\n");
}

// ---------------------------------------------------------------------------
// Links, imagens e mídia
// ---------------------------------------------------------------------------

/**
 * Contexto de escape para inline aninhado: dentro de célula de tabela o
 * escape de tabela (pipe/br) precisa ser preservado pelo conteúdo aninhado.
 */
function inlineCtx(opts: RenderOptions, base: MarkdownEscapeContext): MarkdownEscapeContext {
	return opts.escapeCtx === "table-cell" ? "table-cell" : base;
}

function renderLink($: CheerioAPI, node: Element, opts: RenderOptions): string {
	const href = resolveUrl(attr($, node, "href"), opts.baseUrl, opts.allowedProtocols);
	const text = renderChildren($, node, {
		...opts,
		escapeCtx: inlineCtx(opts, "link-text"),
	}).trim();
	if (!href) return text || "";
	const label = text || escapeText(href, "link-text");
	return `[${label}](${escapeUrl(href)})`;
}

function renderArea($: CheerioAPI, node: Element, opts: RenderOptions): string {
	const href = resolveUrl(attr($, node, "href"), opts.baseUrl, opts.allowedProtocols);
	if (!href) return "";
	const alt = attr($, node, "alt") ?? "";
	return `[${escapeText(alt || href, "link-text")}](${escapeUrl(href)})`;
}

function renderImage($: CheerioAPI, node: Element, opts: RenderOptions): string {
	const src = resolveUrl(attr($, node, "src"), opts.baseUrl, opts.allowedProtocols);
	const alt = escapeText(
		(attr($, node, "alt") ?? "").replace(/\s+/g, " ").trim(),
		inlineCtx(opts, "image-alt"),
	);
	if (!src) return alt;
	return `![${alt}](${escapeUrl(src)})`;
}

/** <picture>: primeiro <img> com src resolvível. */
function renderPicture($: CheerioAPI, node: Element, opts: RenderOptions): string {
	for (const img of $(node).find("img")) {
		if (resolveUrl(attr($, img, "src"), opts.baseUrl, opts.allowedProtocols)) {
			return renderImage($, img, opts);
		}
	}
	return "";
}

/** <audio>/<video>: link textual com rótulo; fallback para <source>. */
function renderMedia($: CheerioAPI, node: Element, opts: RenderOptions): string {
	const label = node.tagName.toLowerCase() === "video" ? "Vídeo" : "Áudio";
	let src = resolveUrl(attr($, node, "src"), opts.baseUrl, opts.allowedProtocols);
	if (!src) {
		const source = $(node).find("source").first();
		src = resolveUrl(attr($, source, "src"), opts.baseUrl, opts.allowedProtocols);
	}
	const text = renderChildren($, node, opts).trim();
	if (!src) return text;
	return `[${text ? `${label}: ${text}` : label}](${escapeUrl(src)})`;
}

// ---------------------------------------------------------------------------
// Formulários (Fase 4)
// ---------------------------------------------------------------------------

/**
 * <input>: checkbox → `[x]`/`[ ]`, radio → `(x)`/`( )`,
 * botões → texto do `value` (sem ação); demais tipos → ignorado.
 */
function renderInput($: CheerioAPI, node: Element): string | null {
	const type = (attr($, node, "type") ?? "text").toLowerCase();
	if (type === "checkbox") {
		return attr($, node, "checked") !== undefined ? "[x]" : "[ ]";
	}
	if (type === "radio") {
		return attr($, node, "checked") !== undefined ? "(x)" : "( )";
	}
	if (type === "button" || type === "submit" || type === "reset") {
		const v = (attr($, node, "value") ?? "").trim();
		return v ? escapeText(v) : null;
	}
	return null; // text/search/email/url/password/number/hidden/... → ignorado
}

/** Linhas de opções de um select/datalist (opções diretas + dentro de optgroup). */
function selectLines($: CheerioAPI, node: Element): string[] {
	const lines: string[] = [];
	for (const child of node.children ?? []) {
		if (!isElement(child)) continue;
		const tag = child.tagName.toLowerCase();
		if (tag === "option") {
			const t = $(child).text().replace(/\s+/g, " ").trim();
			if (!t) continue;
			const selected = attr($, child, "selected") !== undefined;
			lines.push(`- ${selected ? `**${escapeText(t)}**` : escapeText(t)}`);
		} else if (tag === "optgroup") {
			const title = (attr($, child, "label") ?? "").trim();
			if (title) lines.push(`**${escapeText(title)}**`);
			lines.push(...selectLines($, child));
		}
	}
	return lines;
}

/** <select>/<datalist>: lista de opções; selecionada destacada em negrito. */
function renderSelect($: CheerioAPI, node: Element): string | null {
	const lines = selectLines($, node);
	return lines.length ? lines.join("\n") : null;
}

/**
 * Bloco de código cru (textarea, listing, xmp, plaintext).
 * plaintext: parser inclui o `</plaintext>` literal no texto — remove o sufixo.
 */
function renderRawTextBlock($: CheerioAPI, node: Element): string | null {
	const t = $(node)
		.text()
		.replace(/<\/plaintext>\s*$/i, "")
		.replace(/\s+$/, "");
	if (!t.trim()) return null;
	return `${fenceFor(t)}\n${t}\n${fenceFor(t)}`;
}

/** <optgroup> isolado: título em negrito + opções. */
function renderOptgroup($: CheerioAPI, node: Element): string | null {
	const title = (attr($, node, "label") ?? "").trim();
	const out = [...(title ? [`**${escapeText(title)}**`] : []), ...selectLines($, node)];
	return out.length ? out.join("\n") : null;
}
