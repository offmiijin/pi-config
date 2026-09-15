import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  detectProjectContext,
  formatProjectContext,
  saveProjectContext,
  type ProjectContext,
} from "./context.ts";

export default function (pi: ExtensionAPI): void {
  let workspaceCwd = process.cwd();
  let current: ProjectContext | null = null;
  let refreshInFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const next = await detectProjectContext(workspaceCwd);
      await saveProjectContext(workspaceCwd, next);
      current = next;
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  };

  // O sandbox publica o workspace efetivo (worktree ou in-place) antes dos
  // demais listeners de session_start continuarem.
  pi.events?.on("custom:dev-sandbox-session", (event: unknown) => {
    const cwd = (event as { workspaceCwd?: unknown })?.workspaceCwd;
    if (typeof cwd === "string" && cwd.trim()) workspaceCwd = cwd;
  });
  pi.events?.on("custom:dev-sandbox-session-shutdown", () => {
    workspaceCwd = process.cwd();
    current = null;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (workspaceCwd === process.cwd() && ctx.cwd) workspaceCwd = ctx.cwd;
    try { await refresh(); } catch (error) {
      console.warn("[pi-project-context] Não foi possível detectar o projeto:", error);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (ctx.cwd && workspaceCwd !== ctx.cwd) workspaceCwd = ctx.cwd;
    try { await refresh(); } catch (error) {
      console.warn("[pi-project-context] Não foi possível atualizar o contexto:", error);
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!current) {
      try { await refresh(); } catch { return; }
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${formatProjectContext(current!)}` };
  });
}
