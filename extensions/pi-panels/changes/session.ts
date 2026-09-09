/** Estado mínimo persistido para reconstruir a âncora Git da sessão. */
export const PANEL_SESSION_ENTRY = "pi-panel-session";

export interface PanelSessionState {
	version: 1;
	baseCommit: string;
	worktreePath?: string;
	workspaceCwd?: string;
}

export interface PanelSessionEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function normalizePanelSession(value: unknown): PanelSessionState | null {
	if (typeof value !== "object" || value === null) return null;
	const data = value as Record<string, unknown>;
	if (data.version !== 1 || typeof data.baseCommit !== "string") return null;
	const baseCommit = data.baseCommit.trim();
	const worktreePath = typeof data.worktreePath === "string" ? data.worktreePath.trim() : undefined;
	const workspaceCwd = typeof data.workspaceCwd === "string" ? data.workspaceCwd.trim() : undefined;
	if (!baseCommit) return null;
	const state: PanelSessionState = { version: 1, baseCommit };
	if (worktreePath) state.worktreePath = worktreePath;
	if (workspaceCwd) state.workspaceCwd = workspaceCwd;
	return state;
}

/**
 * Recupera o último snapshot válido da âncora Git no branch atual da sessão.
 * Entradas inválidas são ignoradas para que não apaguem uma âncora anterior.
 */
export function reconstructPanelSession(entries: readonly PanelSessionEntry[]): PanelSessionState | null {
	let state: PanelSessionState | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PANEL_SESSION_ENTRY) continue;
		const normalized = normalizePanelSession(entry.data);
		if (normalized) state = normalized;
	}
	return state;
}
