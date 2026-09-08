import { describe, expect, it } from "vitest";
import { blockedReason } from "./index";
import { agentConfig as planner } from "./planner";

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
});
