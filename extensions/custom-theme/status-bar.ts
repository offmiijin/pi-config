/**
 * Status bar — editor customizado com info do modelo + footer com branch git.
 *
 * Refatorado de extensions/status-bar.ts para export nomeado.
 */

import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, SelectListTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
	if (n >= 1_000) return Math.floor(n / 1_000) + "K";
	return String(n);
}

class ModelInfoEditor extends CustomEditor {
	private uiTheme: Theme;
	private modelId = "unknown";
	private provider = "";
	private thinking = "off";
	private agentType = "coder";
	private sessionTokens = 0;
	private sessionCost = 0;
	private lastInput = 0;
	private lastOutput = 0;
	private contextUsage = 0;
	private contextWindow = 0;
	private memoryTotal = 0;
	private piVersion = "";

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		uiTheme: Theme,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.uiTheme = uiTheme;
	}

	setAgentType(type: string) {
		this.agentType = type;
		this.invalidate();
	}

	setModelInfo(id: string, provider: string, thinking: string) {
		this.modelId = id;
		this.provider = provider;
		this.thinking = thinking;
		this.invalidate();
	}

	setContextInfo(usage: number, window?: number) {
		this.contextUsage = usage;
		if (window !== undefined) this.contextWindow = window;
		this.invalidate();
	}

	setTokenInfo(input: number, output: number, total: number, cost: number) {
		this.lastInput = input;
		this.lastOutput = output;
		this.sessionTokens = total;
		this.sessionCost = cost;
		this.invalidate();
	}

	setMemoryInfo(total: number) {
		this.memoryTotal = total;
		this.invalidate();
	}

	setPiVersion(version: string) {
		this.piVersion = version;
		this.invalidate();
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (width <= 4) return lines;

		const borderFg = (text: string) => this.uiTheme.fg("border", text);
		const mutedFg = this.uiTheme.fg.bind(this.uiTheme, "borderMuted");
		const dimFg = this.uiTheme.fg.bind(this.uiTheme, "dim");

		const rail = borderFg("│ ");
		const railW = 2;
		const innerW = Math.max(1, width - railW);

		const fill = (s: string) => {
			const t = truncateToWidth(s, Math.max(0, innerW), "");
			return t + " ".repeat(Math.max(0, innerW - visibleWidth(t)));
		};

		const agentBadge = (() => {
			const label = " " + this.agentType.toUpperCase() + " ";
			switch (this.agentType) {
				case "writer": return this.uiTheme.bg("toolSuccessBg", this.uiTheme.fg("success", label));
				case "planner": return this.uiTheme.bg("selectedBg", this.uiTheme.fg("warning", label));
				default: return this.uiTheme.bg("customMessageBg", this.uiTheme.fg("accent", label));
			}
		})();

		const ctxStr = this.contextWindow > 0
			? `${this.uiTheme.fg("muted", `${Math.round(this.contextUsage / this.contextWindow * 100)}% (${formatTokenCount(this.contextUsage)}/${formatTokenCount(this.contextWindow)})`)} `
			: "";
		const tokenInfo = dimFg(`${ctxStr}\u2191 ${formatTokenCount(this.lastInput)}/${formatTokenCount(this.lastOutput)} \u2193 ${formatTokenCount(this.sessionTokens)} $${this.sessionCost.toFixed(2)}`);

		const topBorder = mutedFg("\u2500".repeat(width));

		// Linha superior — versão do pi à esquerda, info de memória à direita
		const versionInfo = this.piVersion && this.piVersion !== "unknown"
			? this.uiTheme.fg("accent", "\u03c0") + " " + this.uiTheme.fg("muted", this.piVersion)
			: "";
		const memoryInfo = [
			this.uiTheme.fg("muted", "\u{1f9e0}"), // 🧠
			this.uiTheme.fg("accent", String(this.memoryTotal)),
		].join(" ");
		const memT = truncateToWidth(memoryInfo, innerW);
		const memW = visibleWidth(memT);
		const verT = truncateToWidth(versionInfo, Math.max(0, innerW - memW));
		const verW = visibleWidth(verT);
		const memoryLine =
			rail + verT + " ".repeat(Math.max(0, innerW - verW - memW)) + memT;

		const bottomBorder = mutedFg("\u2500".repeat(width));

		const stripped = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

		let borderIdx = lines.length - 1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (stripped(lines[i]).trim().match(/^\u2500+$/)) {
				borderIdx = i;
				break;
			}
		}

		const editorLines = lines.slice(1, borderIdx);
		const autoComplete = lines.slice(borderIdx + 1);

		const paddedContent = editorLines.map((line) => rail + fill(line));
		const spacer = rail + fill("");

		const rightPart = tokenInfo;
		const rightW = visibleWidth(rightPart);

		// Calculates available space for modelId inside innerW
		// Reserva: gap mínimo (1) + rightW + provider + thinking + badge
		const providerStr = this.provider ? " " + this.uiTheme.fg("muted", this.provider) : "";
		const thinkingStr = " " + this.uiTheme.fg("dim", this.thinking);
		const agentBadgeStr = " " + agentBadge;
		const fixedOverheadW = visibleWidth(providerStr) + visibleWidth(thinkingStr) + visibleWidth(agentBadgeStr);
		const availableForModelId = Math.max(0, innerW - 1 - fixedOverheadW - rightW);

		const truncatedModelId = availableForModelId > 0
			? truncateToWidth(this.modelId, availableForModelId, "…")
			: "";

		const leftPart = [
			borderFg(truncatedModelId),
			providerStr,
			thinkingStr,
			agentBadgeStr,
		].join("");

		const leftW = visibleWidth(leftPart);
		const gap = Math.max(1, innerW - leftW - rightW);
		const metaLine = truncateToWidth(rail + leftPart + " ".repeat(gap) + rightPart, width);

		return [topBorder, memoryLine, ...paddedContent, spacer, metaLine, bottomBorder, ...autoComplete];
	}
}

/**
 * Resolve a versão do pi em execução.
 * 1) package.json ao lado do binário (instalações mise)
 * 2) fallback: `pi --version`
 */
async function resolvePiVersion(pi: ExtensionAPI): Promise<string> {
	try {
		const pkgPath = path.join(path.dirname(process.execPath), "package.json");
		if (existsSync(pkgPath)) {
			const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
			if (typeof version === "string" && version.trim()) {
				return version.trim().replace(/^v/, "");
			}
		}
	} catch {}
	try {
		const r = await pi.exec("pi", ["--version"], { timeout: 5000 });
		if (r.code === 0 && r.stdout.trim()) {
			return r.stdout.trim().replace(/^v/, "");
		}
	} catch {}
	return "unknown";
}

export function registerStatusBar(pi: ExtensionAPI) {
	let currentThinking: string = "off";
	let editorRef: ModelInfoEditor | null = null;
	let sessionTokens = 0;
	let sessionCost = 0;
	let footerDataRef: any = null;
	let piVersion = "unknown";

	// Resolve a versão do pi em execução (uma vez por processo)
	resolvePiVersion(pi).then((v) => {
		piVersion = v;
		editorRef?.setPiVersion(v);
	});

	// ── escuta agente-switcher ─────────────────────────────────
	pi.events?.on("custom:agent-switch", ({ type }: { type: string }) => {
		if (["coder", "writer", "planner"].includes(type)) {
			editorRef?.setAgentType(type);
		}
	});

	// ── escuta stats de memória (emitido pelo pi-memory) ──────
	// Guarda o último valor: o editor só existe após session_start — se o
	// evento chegar antes, aplica quando o editor for criado.
	let lastMemoryTotal = 0;
	pi.events?.on("custom:memory-stats", ({ total }: { total: number }) => {
		lastMemoryTotal = total;
		editorRef?.setMemoryInfo(total);
	});

	// ── helper: read agent type from session ──
	function readAgentTypeFromSession(ctx: any): string {
		try {
			const entries = ctx.sessionManager?.getEntries() ?? [];
			const stateEntry = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "agent-switcher")
				.pop() as { data?: { agent?: string } } | undefined;
			const type = stateEntry?.data?.agent;
			if (type && ["coder", "writer", "planner"].includes(type)) return type;
		} catch {}
		return "coder";
	}

	pi.on("session_start", async (_event, ctx) => {
		let folderName = path.basename(ctx.cwd);
		let sandboxBranch = "";
		let originalBranch = "";
		try {
			const metadata = JSON.parse(readFileSync(path.join(ctx.cwd, ".pi-sandbox-worktree.json"), "utf8")) as {
				originalCwd?: string;
				branchName?: string;
				originalBranchName?: string;
			};
			if (metadata.originalCwd) folderName = path.basename(metadata.originalCwd);
			sandboxBranch = metadata.branchName || "";
			originalBranch = metadata.originalBranchName || "";
		} catch {}
		currentThinking = pi.getThinkingLevel() || "off";

		const entries = ctx.sessionManager.getEntries();
		sessionTokens = 0;
		sessionCost = 0;
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "assistant" && entry.message.usage) {
				sessionTokens += entry.message.usage.totalTokens;
				sessionCost += entry.message.usage.cost.total;
			}
		}

		const modelId = ctx.model?.id || "unknown";
		const provider = ctx.model?.provider || "";
		const currentAgent = readAgentTypeFromSession(ctx);

		ctx.ui.setEditorComponent((tui: TUI, baseTheme: EditorTheme, keybindings: KeybindingsManager) => {
			const uiTheme = ctx.ui.theme;

			// Custom SelectListTheme with background highlight + visible prefix
			const selectList: SelectListTheme = {
				// Ignore the default "> ", replace with "▶ " + bg highlight
				selectedPrefix: () => uiTheme.fg("accent", uiTheme.bg("selectedBg", "▶ ")),
				// Selected item text with bg highlight
				selectedText: (text) => uiTheme.fg("accent", uiTheme.bg("selectedBg", text)),
				// Description kept for all items
				description: (text) => uiTheme.fg("muted", text),
				scrollInfo: (text) => uiTheme.fg("muted", text),
				noMatch: (text) => uiTheme.fg("muted", text),
			};

			const editor = new ModelInfoEditor(tui, { ...baseTheme, selectList }, keybindings, uiTheme);
			editorRef = editor;
			editor.setModelInfo(modelId, provider, currentThinking);
			editor.setAgentType(currentAgent);
			editor.setPiVersion(piVersion);
			const ctxW = ctx.model?.contextWindow || 0;
			const ctxU = ctx.getContextUsage?.()?.tokens || 0;
			editor.setContextInfo(ctxU, ctxW);
			editor.setTokenInfo(0, 0, sessionTokens, sessionCost);
			// Último stats recebido do pi-memory (pode ter chegado antes do editor existir)
			editor.setMemoryInfo(lastMemoryTotal);
			return editor;
		});

		ctx.ui.setFooter((tui, theme, footerData) => {
			footerDataRef = footerData;

			const renderLine = (width: number): string[] => {
				const branch = sandboxBranch || footerData.getGitBranch() || "no-branch";

				const leftPart = [
					theme.fg("accent", "\u{f07c}"),
					theme.fg("accent", " " + folderName),
					theme.fg("muted", " on "),
					theme.fg("borderAccent", branch),
					originalBranch ? theme.fg("muted", " refs ") : theme.fg("warning", " \u{3bb}"),
					originalBranch ? theme.fg("warning", originalBranch) : "",
				].join("");

				const statuses = footerData.getExtensionStatuses();
				const cavemanText = statuses?.get("caveman") || "";

				const leftW = visibleWidth(leftPart);
				const cavemanW = visibleWidth(cavemanText);
				const gap = Math.max(1, width - leftW - cavemanW);

				const fullLine = leftPart + " ".repeat(gap) + cavemanText;
				return [truncateToWidth(fullLine, width)];
			};

			return {
				render: renderLine,
				invalidate() {},
				// force=true: renderiza mesmo se outro render pendente (burlaka Gap 1)
				dispose: footerData.onBranchChange(() => tui.requestRender(true)),
			};
		});
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		currentThinking = event.level;
		editorRef?.setModelInfo(
			ctx.model?.id || "unknown",
			ctx.model?.provider || "",
			currentThinking,
		);
	});

	pi.on("model_select", async (event, ctx) => {
		editorRef?.setModelInfo(
			event.model.id,
			event.model.provider || "",
			currentThinking,
		);
		const ctxW = event.model.contextWindow || 0;
		const ctxU = ctx.getContextUsage?.()?.tokens || 0;
		editorRef?.setContextInfo(ctxU, ctxW);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant" && event.message.usage) {
			const u = event.message.usage;
			sessionTokens += u.totalTokens;
			sessionCost += u.cost.total;
			editorRef?.setTokenInfo(u.input, u.output, sessionTokens, sessionCost);
			const ctxU = ctx.getContextUsage?.()?.tokens || 0;
			editorRef?.setContextInfo(ctxU);
		}
		// Refresh agent type badge (agent-switcher persists via appendEntry)
		if (event.message.role === "assistant") {
			editorRef?.setAgentType(readAgentTypeFromSession(ctx));
			// Force branch refresh after the model responds
			setTimeout(() => footerDataRef?.refreshGitBranchAsync?.(), 100);
		}
	});

	// Refresh agent type at start of each turn (fallback)
	pi.on("turn_start", async (_event, ctx) => {
		editorRef?.setAgentType(readAgentTypeFromSession(ctx));
	});
}
