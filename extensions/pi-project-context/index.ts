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
  let currentCwd: string | null = null;
  let refreshInFlight: Promise<void> | null = null;

  const setWorkspaceCwd = (cwd: string, invalidate = false): void => {
    if (!cwd.trim() || (!invalidate && cwd === workspaceCwd)) return;
    workspaceCwd = cwd;
    current = null;
    currentCwd = null;
  };

  const refresh = async (force = false): Promise<void> => {
    while (true) {
      if (refreshInFlight) {
        await refreshInFlight;
        continue;
      }

      const cwd = workspaceCwd;
      if (!force && current && currentCwd === cwd) return;

      const run = (async () => {
        const next = await detectProjectContext(cwd);
        await saveProjectContext(cwd, next);
        if (workspaceCwd === cwd) {
          current = next;
          currentCwd = cwd;
        }
      })();
      refreshInFlight = run;

      try {
        await run;
      } finally {
        if (refreshInFlight === run) refreshInFlight = null;
      }

      if (workspaceCwd === cwd) return;
    }
  };

  // O sandbox publica o workspace efetivo (worktree ou in-place) antes dos
  // demais listeners de session_start continuarem.
  pi.events?.on("custom:dev-sandbox-session", (event: unknown) => {
    const cwd = (event as { workspaceCwd?: unknown })?.workspaceCwd;
    if (typeof cwd === "string") setWorkspaceCwd(cwd, true);
  });
  pi.events?.on("custom:dev-sandbox-session-shutdown", () => {
    setWorkspaceCwd(process.cwd());
    current = null;
    currentCwd = null;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (workspaceCwd === process.cwd() && ctx.cwd) setWorkspaceCwd(ctx.cwd);
    try {
      await refresh(true);
    } catch (error) {
      console.warn("[pi-project-context] Não foi possível detectar o projeto:", error);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (ctx.cwd) setWorkspaceCwd(ctx.cwd);
    try {
      await refresh(true);
    } catch (error) {
      console.warn("[pi-project-context] Não foi possível atualizar o contexto:", error);
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!current || currentCwd !== workspaceCwd) {
      try {
        await refresh();
      } catch {
        return;
      }
    }
    if (!current || currentCwd !== workspaceCwd) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${formatProjectContext(current)}` };
  });
}
