/**
 * Tests for html-to-markdown (Fase 0 — contrato + pipeline)
 *
 * Covers: contrato público (resultado, constantes de regras globais) e o
 * placeholder atual (texto seguro — sem HTML bruto, sem URLs executáveis,
 * sem conteúdo de tags removidas). Renderização real (links, blocos,
 * escape por contexto) chega nas fases 1+.
 */

import { describe, it, expect } from "vitest";
import {
	htmlToMarkdown,
	ALLOWED_PROTOCOLS,
	KEPT_ATTRIBUTES,
} from "../html-to-markdown";

const opts = { baseUrl: "https://example.com/page" };
const md = (html: string) => htmlToMarkdown(html, opts).markdown;

// ---------------------------------------------------------------------------
// Contrato (Fase 0)
// ---------------------------------------------------------------------------
describe("contrato", () => {
	it("retorna { markdown, baseUrl }", () => {
		const r = htmlToMarkdown("<p>x</p>", { baseUrl: "https://a.com/p" });
		expect(r).toEqual({ markdown: "x", baseUrl: "https://a.com/p" });
	});

	it("nunca emite HTML bruto", () => {
		expect(md('<p><a href="https://x.com">link</a></p>')).not.toMatch(
			/<\/?[a-zA-Z][^>]*>/,
		);
	});

	it("nunca emite URL executável", () => {
		expect(md('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
	});

	it("não quebra com baseUrl inválida (mantém como veio)", () => {
		const r = htmlToMarkdown("<p>x</p>", { baseUrl: "not a url" });
		expect(r.baseUrl).toBe("not a url");
		expect(r.markdown).toBe("x");
	});

	it("ALLOWED_PROTOCOLS — apenas https/http/mailto/tel", () => {
		expect([...ALLOWED_PROTOCOLS]).toEqual([
			"https:",
			"http:",
			"mailto:",
			"tel:",
		]);
	});

	it("KEPT_ATTRIBUTES — whitelist do contrato", () => {
		expect([...KEPT_ATTRIBUTES]).toEqual([
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
		]);
	});

	it("entrada vazia → markdown vazio", () => {
		expect(md("")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Placeholder (Fase 0) — texto seguro
// ---------------------------------------------------------------------------
describe("htmlToMarkdown — placeholder", () => {
	it("extrai texto de HTML simples", () => {
		const html = "<html><body><p>Hello World</p></body></html>";
		expect(md(html)).toBe("Hello World");
	});

	it("remove <script> e seu conteúdo", () => {
		const html = `<html><body>
			<p>Visible</p>
			<script>alert("hidden")</script>
			<p>Also visible</p>
		</body></html>`;
		const text = md(html);
		expect(text).toContain("Visible");
		expect(text).toContain("Also visible");
		expect(text).not.toContain("hidden");
	});

	it("remove <style> e seu conteúdo", () => {
		const html = `<html><body>
			<p>Text</p>
			<style>.c{color:red}</style>
		</body></html>`;
		expect(md(html)).toBe("Text");
	});

	it("remove <nav>, <footer>, <header>", () => {
		const html = `<html><body>
			<header>Header</header>
			<nav>Navigation</nav>
			<main><p>Main content</p></main>
			<footer>Footer</footer>
		</body></html>`;
		const text = md(html);
		expect(text).toContain("Main content");
		expect(text).not.toContain("Header");
		expect(text).not.toContain("Navigation");
		expect(text).not.toContain("Footer");
	});

	it("remove elementos com ARIA roles de navegação/banner", () => {
		const html = `<html><body>
			<div role="navigation">Menu</div>
			<div role="banner">Banner</div>
			<div role="contentinfo">Info</div>
			<p>Real content</p>
		</body></html>`;
		const text = md(html);
		expect(text).toContain("Real content");
		expect(text).not.toContain("Menu");
		expect(text).not.toContain("Banner");
		expect(text).not.toContain("Info");
	});

	it("normaliza whitespace excessivo", () => {
		const html = `<html><body>
			<p>  Line 1  </p>
			<p>  Line 2  </p>
			<div>    Tabs\t\there    </div>
		</body></html>`;
		expect(md(html)).toMatch(/^Line 1 Line 2 Tabs here$/);
	});

	it("HTML com apenas elementos removidos → vazio", () => {
		const html = "<html><body><script>x</script><style>y</style></body></html>";
		expect(md(html)).toBe("");
	});

	it("fragmento sem <body> não quebra", () => {
		expect(md("<p>Just a fragment</p>")).toBe("Just a fragment");
	});

	it("remove <noscript> e <svg>", () => {
		const html = `<html><body>
			<noscript>JS required</noscript>
			<svg><text>SVG text</text></svg>
			<p>Real</p>
		</body></html>`;
		expect(md(html)).toBe("Real");
	});

	it("remove <iframe>", () => {
		const html = `<html><body>
			<iframe src="https://other.com"></iframe>
			<p>Content</p>
		</body></html>`;
		expect(md(html)).toBe("Content");
	});
});
