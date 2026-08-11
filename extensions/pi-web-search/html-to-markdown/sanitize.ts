/**
 * Sanitização DOM (Fase 2.1) + escolha de conteúdo (Fase 2.2).
 *
 * Fase 2.1 — limpeza estrutural:
 *   - comentários HTML e doctype removidos
 *   - atributos fora da whitelist (KEPT_ATTRIBUTES) removidos: on*, style,
 *     class, id, name, role, aria-*, data-*, ... (exceção: `class` com
 *     `language-*` em <code>, usada para o fence de código)
 *   - elementos com `hidden` removidos
 *   - nós vazios removidos (exceto void: br, img, hr, source, ...)
 *
 * Fase 2.2 — escolha de conteúdo:
 *   article → main → [role="main"] → body. Sem candidato claro, o
 *   documento inteiro é renderizado.
 */

import type { AnyNode, Element, Text } from "domhandler";
import type { CheerioAPI } from "cheerio";
import { KEPT_ATTRIBUTES } from "./types";

/** Elementos sem filhos que nunca são considerados "vazios" (void). */
const KEEP_EMPTY_TAGS = new Set([
	"br", "img", "hr", "source", "track", "area", "input", "wbr",
	"col", "embed", "param", "command", "keygen",
]);

// ---------------------------------------------------------------------------
// Fase 2.1 — sanitização estrutural
// ---------------------------------------------------------------------------

export function sanitizeDocument($: CheerioAPI): void {
	removeCommentsAndDoctype($);
	$("[hidden]").remove();
	removeEmptyNodes($);
}

/** Remove comentários e doctype em qualquer profundidade. */
function removeCommentsAndDoctype($: CheerioAPI): void {
	$.root()
		.find("*")
		.addBack()
		.each((_, el) => {
			$(el)
				.contents()
				.filter((_, n) => n.type === "comment" || n.type === "directive")
				.remove();
		});
}

/** Remove nós vazios repetidamente até estabilizar (pais esvaziam em cascata). */
function removeEmptyNodes($: CheerioAPI): void {
	let changed = true;
	while (changed) {
		changed = false;
		const empty: Element[] = [];
		$("*").each((_, el) => {
			if (!KEEP_EMPTY_TAGS.has(el.tagName.toLowerCase()) && isEmptyNode(el)) {
				empty.push(el);
			}
		});
		for (const el of empty) {
			$(el).remove();
			changed = true;
		}
	}
}

/** Vazio = sem atributos, sem texto útil e com todos os filhos vazios. */
function isEmptyNode(el: Element): boolean {
	if (el.attribs && Object.keys(el.attribs).length > 0) return false;
	for (const c of el.children ?? []) {
		if (c.type === "text") {
			if ((c as Text).data.trim() !== "") return false;
		} else if (c.type === "tag") {
			if (!isEmptyNode(c as Element)) return false;
		}
	}
	return true;
}

/** Remove atributos fora da whitelist (após a escolha de conteúdo por role). */
export function sanitizeAttributes($: CheerioAPI): void {
	$("*").each((_, el) => {
		for (const name of Object.keys(el.attribs ?? {})) {
			const lower = name.toLowerCase();
			const isLanguageClass =
				lower === "class" &&
				el.tagName.toLowerCase() === "code" &&
				/(?:^|\s)language-[a-zA-Z0-9_+-]+/.test(el.attribs[name] ?? "");
			const allowed =
				KEPT_ATTRIBUTES.includes(lower as (typeof KEPT_ATTRIBUTES)[number]) ||
				isLanguageClass;
			if (!allowed) $(el).removeAttr(name);
		}
	});
}

// ---------------------------------------------------------------------------
// Fase 2.2 — escolha de conteúdo
// ---------------------------------------------------------------------------

/**
 * Seleciona o conteúdo principal: article → main → [role="main"] → body.
 * Retorna undefined apenas em documento sem <body> (usa a raiz).
 */
export function selectContentRoot($: CheerioAPI): Element | undefined {
	for (const sel of ["article", "main", '[role="main"]', "body"]) {
		const el = $(sel).first();
		if (el.length) return el.get(0) as Element;
	}
	return undefined;
}
