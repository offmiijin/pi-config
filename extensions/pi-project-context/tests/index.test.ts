import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import projectContext from "../index.ts";

type Handler = (...args: any[]) => Promise<unknown> | unknown;

async function fixture(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(cwd, ".pi"));
  return cwd;
}

function register() {
  const handlers = new Map<string, Handler>();
  const events = new Map<string, Handler>();
  projectContext({
    on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
    events: { on: vi.fn((name: string, handler: Handler) => events.set(name, handler)) },
  } as never);
  return { handlers, events };
}

describe("integração do contexto do projeto", () => {
  it("atualiza o prompt e o cache quando o workspace muda", async () => {
    const firstCwd = await fixture("pi-context-first-");
    await writeFile(join(firstCwd, "package.json"), JSON.stringify({
      packageManager: "npm@10",
      dependencies: { react: "^19" },
    }));
    const secondCwd = await fixture("pi-context-second-");
    await writeFile(join(secondCwd, "pyproject.toml"), "[project]\nname = 'example'\n");

    const { handlers, events } = register();
    const setWorkspace = events.get("custom:dev-sandbox-session")!;
    const sessionTree = handlers.get("session_tree")!;
    const beforeAgentStart = handlers.get("before_agent_start")!;

    setWorkspace({ workspaceCwd: firstCwd });
    await sessionTree({}, { cwd: firstCwd });
    const firstPrompt = await beforeAgentStart({ systemPrompt: "base" });

    setWorkspace({ workspaceCwd: secondCwd });
    const secondPrompt = await beforeAgentStart({ systemPrompt: "base" });
    const saved = JSON.parse(await readFile(join(secondCwd, ".pi", "project-context.json"), "utf8"));

    expect(firstPrompt.systemPrompt).toContain("React");
    expect(secondPrompt.systemPrompt).toContain("Python");
    expect(secondPrompt.systemPrompt).not.toContain("React");
    expect(saved.stack).toEqual(["Python"]);

  });
});
