/**
 * Tests for html-to-markdown (Fase 1 — núcleo CommonMark seguro)
 *
 * Covers: contrato público (invariantes, constantes) e o renderer por tag
 * (títulos, parágrafos, listas, citações, código, ênfase, links, imagens,
 * mídia, tags removidas e escape). Tabelas/formulários: fases 3-4.
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
// Contrato (invariantes globais)
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
		const html =
			'<p><a href="javascript:alert(1)">x</a> <a href="data:text/html;base64,xx">y</a></p>';
		expect(md(html)).not.toContain("javascript:");
		expect(md(html)).not.toContain("data:");
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

	it("HTML com apenas elementos removidos → vazio", () => {
		const html = "<html><body><script>x</script><style>y</style></body></html>";
		expect(md(html)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Títulos, parágrafos e separadores
// ---------------------------------------------------------------------------
describe("títulos e blocos", () => {
	it("converte h1-h6 com prefixo #", () => {
		const html = "<h1>A</h1><h2>B</h2><h6>F</h6>";
		expect(md(html)).toBe("# A\n\n## B\n\n###### F");
	});

	it("título vazio não é emitido", () => {
		expect(md("<h1></h1><p>x</p>")).toBe("x");
	});

	it("parágrafos separados por linha em branco", () => {
		expect(md("<p>um</p><p>dois</p>")).toBe("um\n\ndois");
	});

	it("div/section/article são transparentes", () => {
		expect(md("<section><div><p>x</p></div></section>")).toBe("x");
	});

	it("hr vira ---", () => {
		expect(md("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
	});

	it("br vira quebra de linha", () => {
		expect(md("<p>a<br>b</p>")).toBe("a\nb");
	});

	it("normaliza whitespace entre blocos", () => {
		const html = "<p>  Line 1  </p><p>  Line 2  </p><div>    Tabs here    </div>";
		expect(md(html)).toBe("Line 1\n\nLine 2\n\nTabs here");
	});

	it("fragmento sem <body> não quebra", () => {
		expect(md("<p>Just a fragment</p>")).toBe("Just a fragment");
	});
});

// ---------------------------------------------------------------------------
// Ênfase e código
// ---------------------------------------------------------------------------
describe("ênfase e código", () => {
	it("strong/b → **texto**", () => {
		expect(md("<p><strong>negrito</strong> e <b>também</b></p>")).toBe(
			"**negrito** e **também**",
		);
	});

	it("em/i → *texto*", () => {
		expect(md("<p><em>itálico</em> e <i>também</i></p>")).toBe(
			"*itálico* e *também*",
		);
	});

	it("código inline preserva conteúdo cru (sem escape)", () => {
		expect(md("<p><code>a_b*c</code></p>")).toBe("`a_b*c`");
	});

	it("código inline com backtick usa delimitador maior", () => {
		expect(md("<p><code>a`b</code></p>")).toBe("``a`b``");
	});

	it("kbd/samp/var → código inline", () => {
		expect(md("<p><kbd>Ctrl</kbd> <samp>out</samp> <var>x</var></p>")).toBe(
			"`Ctrl` `out` `x`",
		);
	});

	it("bloco de código com linguagem", () => {
		const html = '<pre><code class="language-ts">const a = 1;</code></pre>';
		expect(md(html)).toBe("```ts\nconst a = 1;\n```");
	});

	it("bloco de código sem linguagem", () => {
		expect(md("<pre><code>plain</code></pre>")).toBe("```\nplain\n```");
	});

	it("fence maior que backticks do conteúdo", () => {
		expect(md("<pre><code>a```b</code></pre>")).toBe("````\na```b\n````");
	});
});

// ---------------------------------------------------------------------------
// Citações e definições
// ---------------------------------------------------------------------------
describe("blockquote, dl e miscelânea", () => {
	it("blockquote prefixa cada linha com >", () => {
		expect(md("<blockquote><p>citação</p></blockquote>")).toBe("> citação");
	});

	it("blockquote com múltiplos parágrafos mantém separação", () => {
		expect(md("<blockquote><p>a</p><p>b</p></blockquote>")).toBe(
			"> a\n>\n> b",
		);
	});

	it("dl/dt/dd → termo em negrito com definição", () => {
		const html = "<dl><dt>Termo</dt><dd>Definição</dd><dt>T2</dt><dd>D2</dd></dl>";
		expect(md(html)).toBe("**Termo**\nDefinição\n\n**T2**\nD2");
	});

	it("q → aspas textuais", () => {
		expect(md("<p>Disse <q>olá</q></p>")).toBe('Disse "olá"');
	});

	it("sub/sup achatados", () => {
		expect(md("<p>H<sub>2</sub>O e 10<sup>3</sup></p>")).toBe("H2O e 103");
	});

	it("ruby descarta anotações rt/rp", () => {
		expect(md("<p><ruby>漢<rt>kan</rt></ruby>字</p>")).toBe("漢字");
	});

	it("address → parágrafo", () => {
		expect(md("<address>Rua X, 10</address>")).toBe("Rua X, 10");
	});

	it("figure/figcaption", () => {
		const html = "<figure><img src=\"https://x.com/i.png\" alt=\"foto\"><figcaption>Legenda</figcaption></figure>";
		expect(md(html)).toBe("![foto](https://x.com/i.png)\n\n*Legenda*");
	});

	it("details/summary destaca o resumo", () => {
		expect(md("<details><summary>Título</summary><p>Corpo</p></details>")).toBe(
			"**Título**\n\nCorpo",
		);
	});
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
describe("links", () => {
	it("link absoluto", () => {
		expect(md('<p><a href="https://x.com">site</a></p>')).toBe(
			"[site](https://x.com)",
		);
	});

	it("link relativo resolvido contra baseUrl", () => {
		expect(md('<a href="/path?a=1">r</a>')).toBe(
			"[r](https://example.com/path?a=1)",
		);
	});

	it("fragmento preservado", () => {
		expect(md('<a href="#secao">s</a>')).toBe(
			"[s](https://example.com/page#secao)",
		);
	});

	it("mailto e tel preservados", () => {
		expect(md('<a href="mailto:a@b.com">email</a>')).toBe(
			"[email](mailto:a@b.com)",
		);
		expect(md('<a href="tel:+5511">fone</a>')).toBe("[fone](tel:+5511)");
	});

	it("javascript: perde o link mas mantém o texto", () => {
		expect(md('<a href="javascript:alert(1)">x</a>')).toBe("x");
	});

	it("a sem href → apenas texto", () => {
		expect(md("<a>x</a>")).toBe("x");
	});

	it("link sem texto → URL como texto", () => {
		expect(md('<a href="https://x.com"></a>')).toBe(
			"[https://x.com](https://x.com)",
		);
	});

	it("link com imagem dentro", () => {
		const html = '<a href="https://x.com"><img src="https://y.com/i.png" alt="i"></a>';
		expect(md(html)).toBe("[![i](https://y.com/i.png)](https://x.com)");
	});
});

// ---------------------------------------------------------------------------
// Imagens e mídia
// ---------------------------------------------------------------------------
describe("imagens e mídia", () => {
	it("img com src e alt", () => {
		expect(md('<img src="https://x.com/i.png" alt="foto">')).toBe(
			"![foto](https://x.com/i.png)",
		);
	});

	it("img relativa resolvida", () => {
		expect(md('<img src="/img/a.png" alt="a">')).toBe(
			"![a](https://example.com/img/a.png)",
		);
	});

	it("img sem src → alt vira texto", () => {
		expect(md('<img alt="descrição">')).toBe("descrição");
	});

	it("picture usa o primeiro img com src", () => {
		const html =
			'<picture><source srcset="https://x.com/a.webp"><img src="https://x.com/a.png" alt="foto"></picture>';
		expect(md(html)).toBe("![foto](https://x.com/a.png)");
	});

	it("audio com src → link Áudio", () => {
		expect(md('<audio src="https://x.com/a.mp3"></audio>')).toBe(
			"[Áudio](https://x.com/a.mp3)",
		);
	});

	it("video com texto → link Vídeo: texto", () => {
		const html = '<video src="https://x.com/v.mp4">tour</video>';
		expect(md(html)).toBe("[Vídeo: tour](https://x.com/v.mp4)");
	});

	it("video usa <source> quando não tem src", () => {
		const html = '<video><source src="https://x.com/v.webm"></video>';
		expect(md(html)).toBe("[Vídeo](https://x.com/v.webm)");
	});

	it("area dentro de map vira link", () => {
		const html = '<map><area href="https://x.com" alt="região"></map>';
		expect(md(html)).toBe("[região](https://x.com)");
	});
});

// ---------------------------------------------------------------------------
// Listas
// ---------------------------------------------------------------------------
describe("listas", () => {
	it("ul simples", () => {
		expect(md("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
	});

	it("ol numera a partir de 1", () => {
		expect(md("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
	});

	it("ol[start] preserva início", () => {
		expect(md('<ol start="3"><li>a</li><li>b</li></ol>')).toBe("3. a\n4. b");
	});

	it("lista aninhada indentada", () => {
		const html = "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>";
		expect(md(html)).toBe("- a\n  - b\n    - c");
	});

	it("item com texto + lista aninhada (tight)", () => {
		const html = "<ul><li>topo<ul><li>filho</li></ul></li></ul>";
		expect(md(html)).toBe("- topo\n  - filho");
	});

	it("item com apenas lista aninhada", () => {
		const html = "<ul><li><ul><li>x</li></ul></li></ul>";
		expect(md(html)).toBe("-\n  - x");
	});

	it("li vazio não gera item", () => {
		expect(md("<ul><li></li><li>x</li></ul>")).toBe("- x");
	});

	it("menu/dir tratados como ul", () => {
		expect(md("<menu><li>x</li></menu>")).toBe("- x");
	});
});

// ---------------------------------------------------------------------------
// Escape e tags removidas/desconhecidas
// ---------------------------------------------------------------------------
describe("escape e remoção", () => {
	it("escapa ênfase e colchetes no texto", () => {
		expect(md("<p>*asterisco* e [x]</p>")).toBe("\\*asterisco\\* e \\[x\\]");
	});

	it("escapa marcadores de lista e # no início de linha", () => {
		expect(md("<p>- item<br># título<br>1. um</p>")).toBe(
			"\\- item\n\\# título\n1\\. um",
		);
	});

	it("escapa < para não virar HTML", () => {
		expect(md("<p>a &lt;div&gt; b</p>")).toBe("a \\<div\\> b");
	});

	it("remove template/math/canvas/object/embed", () => {
		const html =
			"<p>x</p><template>t</template><math>m</math><canvas>c</canvas>" +
			"<object>o</object><embed>e</embed>";
		expect(md(html)).toBe("x");
	});

	it("remove título/meta/link do head", () => {
		const html =
			"<html><head><title>Doc</title><meta name=\"x\"><link rel=\"icon\"></head>" +
			"<body><p>corpo</p></body></html>";
		expect(md(html)).toBe("corpo");
	});

	it("remove nav/footer/header e roles de navegação", () => {
		const html =
			"<header>H</header><nav>N</nav><div role=\"navigation\">M</div>" +
			"<main><p>conteúdo</p></main><footer>F</footer>";
		expect(md(html)).toBe("conteúdo");
	});

	it("remove noscript/svg/iframe", () => {
		const html =
			"<noscript>JS</noscript><svg><text>svg</text></svg>" +
			"<iframe src=\"https://x.com\"></iframe><p>real</p>";
		expect(md(html)).toBe("real");
	});

	it("tag desconhecida preserva só o texto", () => {
		expect(md("<p><custom attr=\"v\">texto</custom></p>")).toBe("texto");
	});

	it("time usa datetime quando não há texto", () => {
		expect(md("<time datetime=\"2026-01-01\">1 jan</time>")).toBe("1 jan");
	});
});
