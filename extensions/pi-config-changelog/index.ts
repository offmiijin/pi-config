/**
 * pi-config-changelog — Exibe o CHANGELOG.md da versão atual do pi-config.
 *
 * Comando: /pi-config-changelog
 *   Lê ~/.pi/agent/CHANGELOG.md (raiz do repositório) e exibe o conteúdo
 *   no chat. O arquivo segue a convenção:
 *     - Branch != main: seção [x.y.z] (última versão lançada) + ## Unreleased
 *     - Na main (release): apenas [x.y.z], sem Unreleased
 *   (Fase 2: parsing de config.json, expansão de ~, tratamento de erros)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHANGELOG_PATH = join(homedir(), ".pi", "agent", "CHANGELOG.md");

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pi-config-changelog", {
		description: "Mostra o changelog da versão atual do pi-config",
		handler: async (_args, ctx) => {
			const content = readChangelog(DEFAULT_CHANGELOG_PATH);
			if (content === null) {
				ctx.ui.notify(
					`❌ CHANGELOG.md não encontrado em ${DEFAULT_CHANGELOG_PATH}`,
					"warning",
				);
				return;
			}
			if (content.trim() === "") {
				ctx.ui.notify("📭 CHANGELOG vazio.", "info");
				return;
			}
			ctx.ui.notify(content, "info");
		},
	});
}

function readChangelog(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}
