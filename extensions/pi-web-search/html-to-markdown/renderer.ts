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
	"h1", "h2", "h3", "h4", "h5", "h6",
]);

/** Tags removidas integralmente (com descendentes) — Fase 1.8. */
const REMOVED_TAGS = new Set([
	"script", "style", "template", "noscript", "iframe", "frame", "frameset",
	"portal", "svg", "math", "canvas", "object", "embed", "applet", "base",
	"link", "meta", "title", "param", "slot",
	"header", "footer", "nav", "aside", "search",
]);

const LIST_TAGS = new Set(["ul", "ol", "menu", "dir"]);

const HEADING_LEVEL: Record<string, number> = {
	h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6,
};

/** Tags achatadas: apenas o conteúdo interno, sem wrapper Markdown. */
const FLATTEN_TAGS = new Set([
	"span", "bdi", "bdo", "wbr", "small", "big", "u", "mark",
	"cite", "dfn", "abbr", "acronym", "time", "data", "sub", "sup",
	"ruby", "rb", "rtc", "rbc",
]);

/** Ponto de entrada: renderiza o documento (ou um container selecionado). */
export function render($: CheerioAPI, opts: RenderOptions, rootEl?: AnyNode): string {
	return renderChildren($, rootEl ?? $.root()[0], opts);
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

	const parts: Array<{ text: string; isBlock: boolean; tag?: string }> = [];
	for (const child of el.children) {
		const rendered = renderNode($, child, opts);
		if (rendered === null || rendered === "") continue;
		const isBlock = isBlockNode(child);
		// Texto puro com só whitespace vira espaço inline (nunca quebra <br>)
		if (!isBlock && child.type === "text" && rendered.trim() === "") {
			parts.push({ text: " ", isBlock: false });
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
			if (!p.isBlock) continue; // whitespace entre blocos → pula
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
		case "article":
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

// ---------------------------------------------------------------------------
// Links, imagens e mídia
// ---------------------------------------------------------------------------

function renderLink($: CheerioAPI, node: Element, opts: RenderOptions): string {
	const href = resolveUrl(attr($, node, "href"), opts.baseUrl, opts.allowedProtocols);
	const text = renderChildren($, node, { ...opts, escapeCtx: "link-text" }).trim();
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
	const alt = escapeText((attr($, node, "alt") ?? "").replace(/\s+/g, " ").trim(), "image-alt");
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
