import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRepeat, Key, matchesKey } from "@earendil-works/pi-tui";
import { collectChanges } from "./git.ts";
import { ChangesPanel } from "./panel.ts";
import { PANEL_SESSION_ENTRY, reconstructPanelSession } from "./session.ts";

const REFRESH_INTERVAL_MS = 1500;
const TOGGLE_DEBOUNCE_MS = 250;

export function shouldTogglePanel(data: string, now: number, lastToggleAt: number): boolean {
	return matchesKey(data, Key.alt("c")) && !isKeyRepeat(data) && now - lastToggleAt >= TOGGLE_DEBOUNCE_MS;
}

/** String não vazia (após trim) ou undefined — payloads de eventos não são confiáveis. */
function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export default function (pi: ExtensionAPI): void {
	let activePanel: ChangesPanel | null = null;
	let closeActivePanel: (() => void) | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let openingPanel = false;
	let lastToggleAt = Number.NEGATIVE_INFINITY;
	let removeTerminalInputListener: (() => void) | undefined;
	let sandboxSession: { worktreePath?: string; workspaceCwd?: string; baseCommit?: string } | undefined;
	let sessionStarted = false;
	let sessionBaseCommit: string | undefined;
	let sessionWorktreePath: string | undefined;
	let sessionWorkspaceCwd: string | undefined;
	let initializeBaseCommit: Promise<void> | undefined;
	let refreshInFlight = false;

	const persistSessionState = (
		baseCommit: unknown,
		paths: { worktreePath?: unknown; workspaceCwd?: unknown } = {},
	): void => {
		const normalized = cleanString(baseCommit);
		const worktreePath = cleanString(paths.worktreePath) ?? sessionWorktreePath;
		const workspaceCwd = cleanString(paths.workspaceCwd) ?? sessionWorkspaceCwd;
		if (!normalized) return;
		const changed =
			sessionBaseCommit !== normalized ||
			sessionWorktreePath !== worktreePath ||
			sessionWorkspaceCwd !== workspaceCwd;
		if (!changed) return;
		sessionBaseCommit = normalized;
		sessionWorktreePath = worktreePath;
		sessionWorkspaceCwd = workspaceCwd;
		try {
			pi.appendEntry(PANEL_SESSION_ENTRY, {
				version: 1,
				baseCommit: normalized,
				...(worktreePath ? { worktreePath } : {}),
				...(workspaceCwd ? { workspaceCwd } : {}),
			});
		} catch (error) {
			console.warn("[pi-panels/changes] Não foi possível persistir a âncora da sessão:", error);
		}
	};

	pi.events?.on("custom:dev-sandbox-session", (event: unknown) => {
		const session = isRecord(event) ? event : {};
		const nextSession = {
			worktreePath: cleanString(session.worktreePath),
			workspaceCwd: cleanString(session.workspaceCwd),
			baseCommit: cleanString(session.baseCommit),
		};
		sandboxSession = nextSession;
		if (sessionStarted && nextSession.baseCommit) {
			persistSessionState(sessionBaseCommit ?? nextSession.baseCommit, nextSession);
		}
	});
	pi.events?.on("custom:dev-sandbox-session-shutdown", () => {
		sandboxSession = undefined;
	});

	const ensureBaseCommit = (ctx: ExtensionContext): Promise<void> => {
		if (sessionBaseCommit) return Promise.resolve();
		if (initializeBaseCommit) return initializeBaseCommit;

		initializeBaseCommit = (async () => {
			try {
				// Aguarda os demais listeners de session_start emitirem o estado do sandbox.
				await Promise.resolve();
				if (sessionBaseCommit) return;
				if (sandboxSession?.baseCommit) {
					persistSessionState(sandboxSession.baseCommit, sandboxSession);
					return;
				}

				const cwd = sandboxSession?.worktreePath ?? sandboxSession?.workspaceCwd ??
					sessionWorktreePath ?? sessionWorkspaceCwd ?? ctx.cwd;
				const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], { timeout: 5000 });
				if (!sessionBaseCommit && result.code === 0) persistSessionState(result.stdout);
			} catch (error) {
				console.warn("[pi-panels/changes] Não foi possível determinar o commit-base:", error);
				// Permite nova tentativa no próximo refresh em vez de falhar para sempre.
				initializeBaseCommit = undefined;
			}
		})();
		return initializeBaseCommit;
	};

	const loadChanges = async (ctx: ExtensionContext) => {
		await ensureBaseCommit(ctx);
		const cwd = sandboxSession?.worktreePath ?? sandboxSession?.workspaceCwd ??
			sessionWorktreePath ?? sessionWorkspaceCwd ?? ctx.cwd;
		return collectChanges(
			cwd,
			async (args) => pi.exec("git", args, { timeout: 5000 }),
			{ baseCommit: sessionBaseCommit },
		);
	};

	const refreshPanel = (ctx: ExtensionContext): void => {
		const panel = activePanel;
		if (!panel || refreshInFlight) return;
		refreshInFlight = true;
		loadChanges(ctx).then((snapshot) => {
			if (activePanel === panel) panel.setSnapshot(snapshot);
		}).catch((error) => {
			console.warn("[pi-panels/changes] Não foi possível atualizar o painel:", error);
		}).finally(() => {
			refreshInFlight = false;
		});
	};

	const openPanel = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui?.notify?.("O painel de alterações requer o modo interativo (TUI).", "error");
			return;
		}

		if (activePanel) {
			closeActivePanel?.();
			return;
		}
		if (openingPanel) return;

		openingPanel = true;
		try {
			let initialSnapshot;
			try {
				initialSnapshot = await loadChanges(ctx);
			} catch (error) {
				console.warn("[pi-panels/changes] Não foi possível carregar as alterações:", error);
				ctx.ui.notify("Não foi possível carregar as alterações do Git.", "error");
				return;
			}
			await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const panel = new ChangesPanel(tui, theme, initialSnapshot, done);
				activePanel = panel;
				closeActivePanel = done;
				refreshTimer = setInterval(() => refreshPanel(ctx), REFRESH_INTERVAL_MS);
				return panel;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "85%",
					maxHeight: "90%",
					margin: 1,
				},
			},
			);
		} finally {
			if (refreshTimer) clearInterval(refreshTimer);
			refreshTimer = undefined;
			activePanel = null;
			closeActivePanel = null;
			openingPanel = false;
		}
	};

	// Alt+C é tratado antes do editor e consumido para evitar
	// ações nativas do editor.
	pi.on("session_start", (event, ctx) => {
		const freshSession = event.reason === "new" || event.reason === "fork";
		const branch = typeof ctx.sessionManager?.getBranch === "function"
			? ctx.sessionManager.getBranch()
			: [];
		const persisted = freshSession ? null : reconstructPanelSession(branch);
		sessionStarted = true;
		sessionBaseCommit = persisted?.baseCommit;
		sessionWorktreePath = persisted?.worktreePath;
		sessionWorkspaceCwd = persisted?.workspaceCwd;
		initializeBaseCommit = undefined;
		if (!sessionBaseCommit) void ensureBaseCommit(ctx);

		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		if (ctx.mode !== "tui") return;

		removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.alt("c"))) return;
			const now = Date.now();
			if (shouldTogglePanel(data, now, lastToggleAt)) {
				lastToggleAt = now;
				void openPanel(ctx);
			}
			// Consome também repetições para que o editor nunca execute outra ação.
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		sandboxSession = undefined;
		sessionStarted = false;
		sessionBaseCommit = undefined;
		sessionWorktreePath = undefined;
		sessionWorkspaceCwd = undefined;
		initializeBaseCommit = undefined;
	});

	// Atualiza rapidamente após operações do agente; o polling cobre alterações
	// feitas por comandos bash e por processos externos.
	pi.on("tool_execution_end", (_event, ctx) => refreshPanel(ctx));
	pi.on("turn_end", (_event, ctx) => refreshPanel(ctx));
	pi.on("session_tree", (_event, ctx) => refreshPanel(ctx));
}
