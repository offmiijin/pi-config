/**
 * Normalização de saída ciente de blocos de código.
 *
 * Regras:
 *   - máximo de duas quebras consecutivas (uma linha em branco entre blocos)
 *   - sem espaço antes de pontuação (.,;:!?)
 *   - sem linhas com espaços finais
 *   - blocos fenced (`pre`) são preservados intactos — sem colapso interno
 */

/**
 * Normaliza o Markdown gerado, linha a linha, protegendo blocos de código
 * cercados por fences de backtick.
 */
export function normalizeMarkdown(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let fence = 0; // tamanho do fence ativo; 0 = fora de bloco de código

	for (let line of lines) {
		if (fence === 0) {
			const open = /^(`{3,})/.exec(line);
			if (open) {
				fence = open[1].length;
				out.push(line);
				continue;
			}
			// Fora do fence: normaliza a linha
			line = line.replace(/[ \t]+$/g, ""); // sem espaços finais
			line = line.replace(/\s+([.,;:!?])/g, "$1"); // sem espaço antes de pontuação
		} else {
			const close = /^(`{3,})\s*$/.exec(line);
			if (close && close[1].length >= fence) fence = 0;
			out.push(line); // código cru — preservado
			continue;
		}

		if (line === "" && out.length > 0 && out[out.length - 1] === "") continue;
		out.push(line);
	}

	return out.join("\n").trim();
}
