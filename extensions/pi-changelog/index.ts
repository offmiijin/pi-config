/**
 * pi-config-changelog — Exibe o CHANGELOG.md da versão atual do pi-config.
 *
 * Comando: /pi-config-changelog
 *
 * Usa appendEntry() + registerEntryRenderer() para renderizar o changelog
 * como entrada no chat com markdown colorido (tema do pi). Essa abordagem
 * substitui ctx.ui.custom() + componente próprio, que travava o TUI.
 *
 * IMPORTANTE: este entry point NÃO pode ter exports nomeados — somente
 * `export default`. Exports nomeados fazem o pi falhar ao carregar com
 * `ResolveMessage: NameTooLong` (data URI do jiti). Lógica em changelog.ts.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
	// Dynamic imports: jiti não embute no bundle (evita NameTooLong).
	const { Markdown } = await import("@earendil-works/pi-tui");

	pi.registerEntryRenderer("changelog-viewer", (entry, _opts, theme: Theme) => {
		const data = entry.data as { content: string };
		return new Markdown(data.content, 1, 1, buildMarkdownTheme(theme));
	});

	pi.registerCommand("pi-config-changelog", {
		description: "Mostra o changelog da versão atual do pi-config",
		handler: async (_args, ctx) => {
			const { runChangelogCommand, getExtensionDir } = await import(
				"./changelog.js"
			);
			await runChangelogCommand(ctx, getExtensionDir(), pi);
		},
	});
}

/** Constrói MarkdownTheme a partir do Theme do pi. */
function buildMarkdownTheme(theme: Theme) {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => theme.strikethrough(text),
	};
}
