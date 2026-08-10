/**
 * pi-config-changelog — Exibe o CHANGELOG.md da versão atual do pi-config.
 *
 * Comando: /pi-config-changelog
 *
 * IMPORTANTE: este entry point NÃO pode ter exports nomeados — somente
 * `export default`. Exports nomeados fazem o pi falhar ao carregar com
 * `ResolveMessage: NameTooLong` (data URI do jiti). Lógica em changelog.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pi-config-changelog", {
		description: "Mostra o changelog da versão atual do pi-config",
		handler: async (_args, ctx) => {
			// Import dinâmico: o jiti embute imports estáticos no entry
			// (data URI > limite → NameTooLong); dinâmicos ficam em runtime.
			const { runChangelogCommand, getExtensionDir } = await import(
				"./changelog.js"
			);
			await runChangelogCommand(ctx, getExtensionDir());
		},
	});
}
