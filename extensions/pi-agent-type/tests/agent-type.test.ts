import { describe, expect, it } from "vitest";
import { blockedReason } from "../index.ts";
import { agentConfig as planner } from "../planner.ts";
import { agentConfig as writer } from "../writer.ts";

describe("restrições dos tipos de agente", () => {
  it("permite Markdown no planner", () => {
    expect(blockedReason(planner, "edit", { path: "docs/plano.md" })).toBeNull();
  });

  it.each(["src/index.ts", "package.json", "README.txt"])(
    "bloqueia edição de %s no planner",
    (path) => expect(blockedReason(planner, "edit", { path })).toContain("restrito"),
  );

  it("não restringe tools sem política de extensão", () => {
    expect(blockedReason(planner, "read", { path: "src/index.ts" })).toBeNull();
  });

  it.each([planner, writer])( "bloqueia bash nos modos com escrita Markdown", (config) => {
    expect(blockedReason(config, "bash", { command: "printf x > src/index.ts" })).toContain("bash");
  });

  it("explicita a restrição Markdown nos prompts", () => {
    expect(planner.agentsMd).toContain("create or alter Markdown files only");
    expect(writer.agentsMd).toContain("create or alter Markdown files only");
  });
});
