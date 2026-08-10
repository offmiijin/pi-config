/**
 * Renderização do changelog no TUI (markdown colorido).
 *
 * Módulo separado para evitar carregar pi-coding-agent/pi-tui em runtime
 * fora do TUI (undici quebra no node <23.6). Importado dinamicamente
 * apenas quando ctx.hasUI === true.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, ScrollView } from "@earendil-works/pi-tui";

/**
 * Cria o visualizador: ScrollView + Markdown com tema, com scroll
 * (↑/↓/PageUp/PageDown/Home/End) e fechamento (Esc/q → done()).
 */
export function createMarkdownView(content: string, done: (result?: unknown) => void) {
	const md = new Markdown(content, 1, 1, getMarkdownTheme());
	const view = new ScrollView(md, { scrollbar: "auto" });

	(view as { handleInput?: (data: string) => void }).handleInput = (data: string) => {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			done(undefined);
			return;
		}
		if (matchesKey(data, Key.up)) view.scrollBy(-1);
		else if (matchesKey(data, Key.down)) view.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) view.scrollBy(-view.viewportHeight);
		else if (matchesKey(data, Key.pageDown)) view.scrollBy(view.viewportHeight);
		else if (matchesKey(data, Key.home)) view.scrollToStart();
		else if (matchesKey(data, Key.end)) view.scrollToEnd();
	};

	return view;
}
