/**
 * Extensão pi-github — Integração com GitHub (PRs, Issues, Search).
 *
 * Tools (LLM chama automaticamente):
 *   github_create_pr     → Cria pull request
 *   github_create_issue  → Cria issue
 *   github_search        → Busca issues/PRs
 *   github_list_prs      → Lista pull requests
 *   github_list_issues   → Lista issues
 *   github_edit_issue    → Edita issue
 *   github_edit_pr       → Edita pull request
 *
 * Comandos (/github):
 *   /github pr create    → Cria PR com editor interativo
 *   /github pr list      → Lista PRs com seletor
 *   /github issue create → Cria issue com editor interativo
 *   /github issue list   → Lista issues com seletor
 *   /github search       → Busca interativa
 *   /github auth         → Mostra status da autenticação
 *   /github help         → Ajuda
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGh } from "./gh";
import { getAuthInfo } from "./auth";
import { createPrTool } from "./tools/create-pr";
import { createIssueTool } from "./tools/create-issue";
import { searchTool } from "./tools/search";
import { listPrsTool } from "./tools/list-prs";
import { listIssuesTool } from "./tools/list-issues";
import { createGithubCommand } from "./commands/github";
import { viewPrTool } from "./tools/view-pr";
import { viewIssueTool } from "./tools/view-issue";
import { editIssueTool } from "./tools/edit-issue";
import { editPrTool } from "./tools/edit-pr";

export default function (pi: ExtensionAPI) {
	// ── gh disponível? ────────────────────────────────────────────────
	const auth = getAuthInfo();

	// Aviso — adiado para session_start (runtime precisa estar pronto)
	// Flag evita repetição em resume/fork
	let notified = false;
	pi.on("session_start", (_event, ctx) => {
		if (notified) return;
		notified = true;

		if (!auth.available) {
			ctx.ui.notify(
				"⚠️ gh CLI não encontrado. Tools GitHub desativadas.",
				"error",
			);
			pi.sendMessage({
				customType: "github_status",
				content: "⚠️ gh CLI não encontrado. Tools GitHub desativadas. Instale: `apt install gh`",
				display: true,
			});
		} else if (!auth.authenticated) {
			ctx.ui.notify(
				"⚠️ gh CLI não autenticado. Tools podem falhar.",
				"warning",
			);
			pi.sendMessage({
				customType: "github_status",
				content:
					"⚠️ gh CLI não autenticado. Tools podem falhar. Autentique: `gh auth login` ou exporte GH_TOKEN",
				display: true,
			});
		}
	});

	if (!auth.available) {
		// gh não instalado — não registra nada
		return;
	}

	// ── gh wrapper (runtime) ──────────────────────────────────────────
	const gh = createGh(pi.exec.bind(pi));

	// ── Tools ─────────────────────────────────────────────────────────
	pi.registerTool(createPrTool(gh));
	pi.registerTool(createIssueTool(gh));
	pi.registerTool(searchTool(gh));
	pi.registerTool(listPrsTool(gh));
	pi.registerTool(listIssuesTool(gh));
	pi.registerTool(viewPrTool(gh));
	pi.registerTool(viewIssueTool(gh));
	pi.registerTool(editIssueTool(gh));
	pi.registerTool(editPrTool(gh));

	// ── Slash Commands ───────────────────────────────────────────────
	pi.registerCommand("github", createGithubCommand(gh));
}
