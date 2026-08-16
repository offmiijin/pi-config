/**
 * Escape para Markdown CommonMark (Fase 1).
 *
 * Protege o texto contra sintaxe introduzida acidentalmente pelo conteúdo
 * original (ênfase, links, listas, títulos, código, HTML). Refinamento por
 * contexto completo (MarkdownEscapeContext) na Fase 2.
 */

import type { MarkdownEscapeContext } from "./types";

/**
 * Escapa texto inline/bloco. Regras:
 *   - `\`, `` ` ``, `*`, `_`, `[`, `]`, `<` — especiais em qualquer lugar
 *   - `#`, `>`, `- `, `+ `, `1. ` — no início de linha
 *
 * Contextos (Fase 2.4):
 *   - heading: prefixo `#` inicial (já coberto pela regra de início de linha)
 *   - list: marcadores `-`/`*`/`+`/`1.` do texto (já cobertos)
 *   - table-cell: além do base, escapa `|` e converte quebras em `<br>`
 */
export function escapeText(text: string, ctx: MarkdownEscapeContext = "text"): string {
	let out = text
		.replace(/\\/g, "\\\\")
		.replace(/[`*_\[\]<>]/g, (c) => `\\${c}`)
		.replace(/^(\s*)#/gm, "$1\\#")
		.replace(/^(\s*)>/gm, "$1\\>")
		.replace(/^(\s*)([-+])(\s)/gm, "$1\\$2$3")
		.replace(/^(\s*)(\d+)\.(\s)/gm, "$1$2\\.$3");
	if (ctx === "table-cell") {
		out = out.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
	}
	return out;
}

/** Maior sequência de backticks no conteúdo. */
function longestBacktickRun(s: string): number {
	let max = 0;
	let cur = 0;
	for (const ch of s) {
		cur = ch === "`" ? cur + 1 : 0;
		if (cur > max) max = cur;
	}
	return max;
}

/**
 * Renderiza código inline: delimitador maior que qualquer sequência de
 * backticks do conteúdo; conteúdo cru (sem escape Markdown).
 */
export function inlineCode(content: string): string {
	const c = content.replace(/\s+/g, " ").trim();
	if (!c) return "";
	const delim = "`".repeat(longestBacktickRun(c) + 1);
	const padded = /^`|`$/.test(c) ? ` ${c} ` : c;
	return `${delim}${padded}${delim}`;
}

/** Fence de bloco de código: ≥3, sempre maior que os backticks do conteúdo. */
export function fenceFor(content: string): string {
	return "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
}

/**
 * Escapa URL de destino de link/imagem.
 * Parênteses/espaços → forma com `<...>` (CommonMark); senão escapa `(`/`)`.
 */
export function escapeUrl(url: string): string {
	const clean = url.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (/[\s()]/.test(clean)) return `<${clean.replace(/[<>]/g, "")}>`;
	return clean
		.replace(/\\/g, "\\\\")
		.replace(/\(/g, "\\(")
		.replace(/\)/g, "\\)")
		.replace(/\|/g, "\\|"); // pipe quebraria célula GFM
}
