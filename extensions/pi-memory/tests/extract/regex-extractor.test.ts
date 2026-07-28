/**
 * Testes do RegexExtractor (N2).
 *
 * Cobre todos os padrões de regex definidos no ADR-002 + edge cases.
 */

import { describe, it, expect } from "vitest";
import { RegexExtractor } from "../../extract/regex-extractor";
import type { RawObservation } from "../../types";

// ── Helpers ────────────────────────────────────────────────────────────

function makeObs(overrides: Partial<RawObservation> = {}): RawObservation {
  return {
    id: "obs-1",
    session_id: "sess-1",
    project_id: "proj-1",
    timestamp: Date.now(),
    type: "tool_result",
    tool_name: "bash",
    input_json: null,
    outcome: "success",
    content_preview: "",
    error_preview: null,
    file_paths: [],
    ttl: Date.now() + 7 * 24 * 60 * 60 * 1000,
    extracted: false,
    ...overrides,
  };
}

// ── Suite ───────────────────────────────────────────────────────────────

describe("RegexExtractor", () => {
  const extractor = new RegexExtractor();

  // ══════════════════════════════════════════════════════════════════
  // 1. Test/Build Failures
  // ══════════════════════════════════════════════════════════════════

  describe("test_failure", () => {
    it("deve detectar testes falhando (formato: X failed, Y passed)", () => {
      const obs = makeObs({
        content_preview: "Tests: 3 failed, 10 passed, 13 total",
        file_paths: ["src/auth.spec.ts"],
      });
      const facts = extractor.extract(obs);
      expect(facts.length).toBeGreaterThanOrEqual(1);
      const fact = facts.find((f) => f.text.includes("test(s) failed"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("3");
      expect(fact!.text).toContain("src/auth.spec.ts");
      expect(fact!.type).toBe("lesson");
      expect(fact!.tags).toContain("#test");
      expect(fact!.tags).toContain("#failure");
    });

    it("deve detectar Specs: X failed", () => {
      const obs = makeObs({
        content_preview: "Specs: 2 failed, 5 passed",
        file_paths: ["login.spec.ts"],
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.text.includes("failed"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar Suites: X failed", () => {
      const obs = makeObs({
        content_preview: "Suites: 1 failed, 0 passed",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.text.includes("failed"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("unknown");
    });

    it("NÃO deve extrair se 0 failed", () => {
      const obs = makeObs({
        content_preview: "Tests: 0 failed, 13 passed, 13 total",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.text.includes("test(s) failed"));
      expect(fact).toBeUndefined();
    });
  });

  describe("build_failure", () => {
    it("deve detectar Build failed", () => {
      const obs = makeObs({
        content_preview: "Build failed with exit code 1",
        file_paths: ["src/main.ts"],
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "lesson" && f.tags.includes("#build"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("src/main.ts");
    });

    it("deve detectar Compilation error", () => {
      const obs = makeObs({
        content_preview: "Compilation error: cannot find module './foo'",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#build"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar Bundle failed", () => {
      const obs = makeObs({
        content_preview: "Bundling failed: out of memory",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#build"));
      expect(fact).toBeTruthy();
    });
  });

  describe("lint_error", () => {
    it("deve detectar ESLint errors", () => {
      const obs = makeObs({
        content_preview: "ESLint errors: 5 warnings: 2",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#lint"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("5");
    });

    it("deve detectar Prettier issues", () => {
      const obs = makeObs({
        content_preview: "Prettier warnings: 3",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#lint"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar Biome errors", () => {
      const obs = makeObs({
        content_preview: "Biome errors: 1",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#lint"));
      expect(fact).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. Dependency Changes
  // ══════════════════════════════════════════════════════════════════

  describe("dependency_added", () => {
    it("deve detectar 'added X packages: pkg@version'", () => {
      const obs = makeObs({
        content_preview: "added 1 package: zod@3.23.8",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#added"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("zod@3.23.8");
      expect(fact!.type).toBe("fact");
      expect(fact!.confidence).toBe(0.75);
    });

    it("deve detectar 'installed 3 packages'", () => {
      const obs = makeObs({
        content_preview: "installed 3 packages: react, react-dom, vite",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#added"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar 'adicionado X dependências'", () => {
      const obs = makeObs({
        content_preview: "adicionada 1 dependência: express@4.18.0",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#added"));
      expect(fact).toBeTruthy();
    });
  });

  describe("dependency_removed", () => {
    it("deve detectar 'removed X packages'", () => {
      const obs = makeObs({
        content_preview: "removed 2 packages: lodash, moment",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#removed"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("lodash, moment");
    });

    it("deve detectar 'uninstalled dependency'", () => {
      const obs = makeObs({
        content_preview: "uninstalled 1 dependency: axios",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#removed"));
      expect(fact).toBeTruthy();
    });
  });

  describe("dependency_updated", () => {
    it("deve detectar 'updated X packages'", () => {
      const obs = makeObs({
        content_preview: "updated 1 package: typescript@5.5.0",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#updated"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar 'upgraded dependency'", () => {
      const obs = makeObs({
        content_preview: "upgraded 1 dependency: vite@5.0.0",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#updated"));
      expect(fact).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. Git Actions
  // ══════════════════════════════════════════════════════════════════

  describe("git_commit", () => {
    it("deve detectar [branch sha] mensagem", () => {
      const obs = makeObs({
        content_preview: "[main a1b2c3d] fix: auth bug in login flow",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#commit"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("main");
      expect(fact!.text).toContain("a1b2c3d");
      expect(fact!.text).toContain("fix: auth bug in login flow");
      expect(fact!.confidence).toBe(0.85);
    });

    it("deve lidar com hash curto", () => {
      const obs = makeObs({
        content_preview: "[feat/login abc1234] feat: add login page",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#commit"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("abc1234");
    });
  });

  describe("git_action_generic", () => {
    it.each(["commit", "push", "merge", "rebase", "checkout", "branch", "switch", "restore"])(
      "deve detectar git %s",
      (action) => {
        const obs = makeObs({
          content_preview: `git ${action} executed successfully`,
        });
        const facts = extractor.extract(obs);
        const fact = facts.find(
          (f) => f.tags.includes("#git") && f.text.includes(action)
        );
        expect(fact).toBeTruthy();
        expect(fact!.confidence).toBe(0.9);
      }
    );
  });

  // ══════════════════════════════════════════════════════════════════
  // 4. Runtime Errors / Stack Traces
  // ══════════════════════════════════════════════════════════════════

  describe("stack_trace", () => {
    it("deve detectar TypeError com mensagem", () => {
      const obs = makeObs({
        error_preview: "TypeError: Cannot read properties of undefined (reading 'map')",
        outcome: "error",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#runtime"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("Cannot read properties");
      expect(fact!.type).toBe("lesson");
      expect(fact!.confidence).toBe(0.8);
    });

    it("deve detectar ReferenceError", () => {
      const obs = makeObs({
        content_preview: "ReferenceError: foo is not defined",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#runtime"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar SyntaxError", () => {
      const obs = makeObs({
        content_preview: "SyntaxError: Unexpected token '}'",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#runtime"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar RangeError", () => {
      const obs = makeObs({
        content_preview: "RangeError: Maximum call stack size exceeded",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#runtime"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar Exception genérico", () => {
      const obs = makeObs({
        content_preview: "Exception: Connection refused",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#runtime"));
      expect(fact).toBeTruthy();
    });
  });

  describe("file_location_error", () => {
    it("deve detectar 'at file:line:col' em stack trace", () => {
      const obs = makeObs({
        error_preview: "    at processUsers (src/auth.ts:42:15)",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#location"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("src/auth.ts");
      expect(fact!.text).toContain("42");
    });

    it("deve detectar 'at file file:line:col'", () => {
      const obs = makeObs({
        error_preview: "    at file src/utils.ts:10:5",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#location"));
      expect(fact).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 5. Preference Declarations
  // ══════════════════════════════════════════════════════════════════

  describe("preference_explicit", () => {
    it("deve detectar 'prefiro usar X'", () => {
      const obs = makeObs({
        content_preview: "Prefiro usar vitest em vez de jest para testes.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "preference" && f.tags.includes("#preference"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("vitest");
    });

    it("deve detectar 'recomendo usar X'", () => {
      const obs = makeObs({
        content_preview: "Recomendo usar hexagonal architecture neste projeto.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "preference");
      expect(fact).toBeTruthy();
    });

    it("deve detectar 'sugiro criar X'", () => {
      const obs = makeObs({
        content_preview: "Sugiro criar testes unitários para cada service.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "preference");
      expect(fact).toBeTruthy();
    });
  });

  describe("always_never_rule", () => {
    it("deve detectar 'Sempre use X'", () => {
      const obs = makeObs({
        content_preview: "Sempre use pnpm em todos os projetos.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "pattern" && f.tags.includes("#convention"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("pnpm");
      expect(fact!.confidence).toBe(0.55);
    });

    it("deve detectar 'Nunca use X'", () => {
      const obs = makeObs({
        content_preview: "Nunca use npm neste projeto.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "pattern");
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("npm");
    });

    it("deve detectar 'always use X'", () => {
      const obs = makeObs({
        content_preview: "Always use TypeScript strict mode.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "pattern");
      expect(fact).toBeTruthy();
    });

    it("deve detectar 'never use X'", () => {
      const obs = makeObs({
        content_preview: "Never use var — use const and let instead.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "pattern");
      expect(fact).toBeTruthy();
    });

    it("deve detectar 'evite usar X'", () => {
      const obs = makeObs({
        content_preview: "Evite usar any como tipo em TypeScript.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "pattern");
      expect(fact).toBeTruthy();
    });

    it("deve detectar 'avoid using X'", () => {
      const obs = makeObs({
        content_preview: "Avoid using class components — prefer hooks.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.type === "pattern");
      expect(fact).toBeTruthy();
    });
  });

  describe("uses_tool", () => {
    it.each(["pnpm", "npm", "yarn", "bun", "docker", "kubernetes", "vite", "webpack", "jest", "vitest"])(
      "deve detectar 'usa/usam/utiliza %s'",
      (tool) => {
        const obs = makeObs({
          content_preview: `O projeto usa ${tool} para build.`,
        });
        const facts = extractor.extract(obs);
        const fact = facts.find((f) => f.tags.includes(`#${tool}`));
        expect(fact).toBeTruthy();
        expect(fact!.type).toBe("preference");
      }
    );

    it("deve detectar 'using X' em inglês", () => {
      const obs = makeObs({
        content_preview: "We are using docker for containerization.",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#docker"));
      expect(fact).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 6. File Operations
  // ══════════════════════════════════════════════════════════════════

  describe("file_created", () => {
    it("deve detectar 'created file X'", () => {
      const obs = makeObs({
        content_preview: "Created file src/components/Button.tsx",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#created"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("src/components/Button.tsx");
      expect(fact!.type).toBe("fact");
    });

    it("deve detectar 'wrote file X'", () => {
      const obs = makeObs({
        content_preview: "Wrote file src/utils/helpers.ts",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#created"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar 'criou arquivo X'", () => {
      const obs = makeObs({
        content_preview: "Criou arquivo README.md",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#created"));
      expect(fact).toBeTruthy();
    });
  });

  describe("file_deleted", () => {
    it("deve detectar 'deleted file X'", () => {
      const obs = makeObs({
        content_preview: "Deleted file src/old/deprecated.ts",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#deleted"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("src/old/deprecated.ts");
    });

    it("deve detectar 'removed file X'", () => {
      const obs = makeObs({
        content_preview: "Removed file legacy.js",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#deleted"));
      expect(fact).toBeTruthy();
    });
  });

  describe("file_modified", () => {
    it("deve detectar 'modified file X'", () => {
      const obs = makeObs({
        content_preview: "Modified file src/services/auth.ts",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#modified"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar 'updated file X'", () => {
      const obs = makeObs({
        content_preview: "Updated file package.json",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#modified"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar 'alterado arquivo X'", () => {
      const obs = makeObs({
        content_preview: "Alterado arquivo docker-compose.yml",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#modified"));
      expect(fact).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 7. Configuration Changes
  // ══════════════════════════════════════════════════════════════════

  describe("config_change", () => {
    it("deve detectar mudança em .env", () => {
      const obs = makeObs({
        content_preview: ".env changed: updated DATABASE_URL",
        tool_name: "edit",
        file_paths: [".env"],
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#config"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain(".env");
    });

    it("deve detectar mudança em tsconfig.json", () => {
      const obs = makeObs({
        content_preview: "tsconfig modified: updated strict mode",
        file_paths: ["tsconfig.json"],
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#config"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar mudança em package.json", () => {
      const obs = makeObs({
        content_preview: "package.json updated: added scripts",
        file_paths: ["package.json"],
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#config"));
      expect(fact).toBeTruthy();
    });

    it("deve detectar mudança em settings", () => {
      const obs = makeObs({
        content_preview: "Settings changed via bash",
        tool_name: "bash",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#config"));
      expect(fact).toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 8. Bash command errors
  // ══════════════════════════════════════════════════════════════════

  describe("bash_error", () => {
    it("deve detectar 'command failed with exit code X'", () => {
      const obs = makeObs({
        content_preview: "command failed with exit code 127",
        input_json: JSON.stringify({ command: "invalid-command --flag" }),
        outcome: "error",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#bash"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("127");
      expect(fact!.text).toContain("invalid-command");
      expect(fact!.type).toBe("lesson");
      expect(fact!.confidence).toBe(0.8);
    });

    it("deve usar tool_name se input_json não tem command", () => {
      const obs = makeObs({
        content_preview: "command failed with exit code 1",
        input_json: null,
        tool_name: "bash",
        outcome: "error",
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#bash"));
      expect(fact).toBeTruthy();
      expect(fact!.text).toContain("bash");
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Edge Cases
  // ══════════════════════════════════════════════════════════════════

  describe("edge cases", () => {
    it("deve retornar array vazio para conteúdo vazio", () => {
      const obs = makeObs({ content_preview: "", error_preview: null });
      expect(extractor.extract(obs)).toEqual([]);
    });

    it("deve retornar array vazio para conteúdo < 10 chars", () => {
      const obs = makeObs({ content_preview: "OK", error_preview: null });
      expect(extractor.extract(obs)).toEqual([]);
    });

    it("deve retornar array vazio para conteúdo trivial (ls output)", () => {
      const obs = makeObs({
        content_preview: "file1.ts\nfile2.ts\nfile3.ts\nfile4.ts",
        tool_name: "ls",
      });
      expect(extractor.extract(obs)).toEqual([]);
    });

    it("deve retornar array vazio para conteúdo trivial (success message)", () => {
      const obs = makeObs({
        content_preview: "Done in 2.3s",
        tool_name: "bash",
      });
      expect(extractor.extract(obs)).toEqual([]);
    });

    it("deve combinar content_preview e error_preview como fonte de scan", () => {
      const obs = makeObs({
        content_preview: "",
        error_preview: "TypeError: foo is not a function",
        outcome: "error",
      });
      const facts = extractor.extract(obs);
      expect(facts.length).toBeGreaterThan(0);
    });

    it("deve incluir texto do comando bash do input_json no scan", () => {
      const obs = makeObs({
        content_preview: "",
        input_json: JSON.stringify({ command: "git push origin main" }),
      });
      const facts = extractor.extract(obs);
      const fact = facts.find((f) => f.tags.includes("#git"));
      expect(fact).toBeTruthy();
    });

    it("deve preencher source_observation_ids com observation.id", () => {
      const obs = makeObs({
        id: "obs-unique-42",
        content_preview: "Tests: 1 failed, 0 passed",
        file_paths: ["test.ts"],
      });
      const facts = extractor.extract(obs);
      expect(facts.length).toBeGreaterThan(0);
      for (const fact of facts) {
        expect(fact.source_observation_ids).toContain("obs-unique-42");
      }
    });

    it("múltiplos patterns podem casar na mesma observação", () => {
      const obs = makeObs({
        content_preview: [
          "Tests: 2 failed, 5 passed",
          "Sempre use pnpm em todos os projetos.",
          "added 1 package: zod@3.23.8",
        ].join("\n"),
        tool_name: "bash",
        file_paths: ["src/auth.spec.ts"],
      });
      const facts = extractor.extract(obs);
      // Deve ter pelo menos 3 fatos: test failure + preference + dependency
      expect(facts.length).toBeGreaterThanOrEqual(3);
    });

    it("não deve quebrar com input_json malformado", () => {
      const obs = makeObs({
        content_preview: "Tests: 1 failed, 0 passed",
        input_json: "not valid json {{{",
        file_paths: ["test.ts"],
      });
      expect(() => extractor.extract(obs)).not.toThrow();
      const facts = extractor.extract(obs);
      expect(facts.length).toBeGreaterThan(0); // scanText ainda usa content_preview
    });

    it("deve lidar com conteúdo muito longo sem quebrar", () => {
      const longContent = "A".repeat(100_000) + " Tests: 3 failed, 0 passed";
      const obs = makeObs({
        content_preview: longContent,
        file_paths: ["huge.spec.ts"],
      });
      expect(() => extractor.extract(obs)).not.toThrow();
    });

    it("cada pattern deve retornar no máximo 1 fato por observação", () => {
      // Texto com "Tests: 1 failed" repetido — só pega primeiro match
      const obs = makeObs({
        content_preview:
          "Tests: 1 failed, 0 passed\nTests: 2 failed, 0 passed\nTests: 3 failed, 0 passed",
        file_paths: ["a.spec.ts"],
      });
      const facts = extractor.extract(obs);
      const testFailures = facts.filter((f) => f.text.includes("test(s) failed"));
      expect(testFailures.length).toBe(1);
    });

    it("deve preservar scopes e types corretos por pattern", () => {
      const obs = makeObs({
        content_preview: "Prefiro usar docker compose para desenvolvimento local.",
      });
      const facts = extractor.extract(obs);

      // preference_explicit → type=preference, scope=project
      const prefFact = facts.find((f) => f.type === "preference");
      expect(prefFact).toBeTruthy();
      expect(prefFact!.scope).toBe("project");

      // uses_tool → pode disparar também (docker)
      const toolFact = facts.find((f) => f.tags.some((t) => t === "#docker"));
      if (toolFact) {
        expect(toolFact.scope).toBe("project");
      }
    });

    it("confidence deve estar no range 0-1 para todos os fatos", () => {
      const obs = makeObs({
        content_preview: [
          "Tests: 1 failed, 0 passed",
          "Build failed",
          "added 1 package: x",
          "[main abc1234] msg",
          "TypeError: boom",
          "Prefiro usar A",
          "Sempre use B",
          "Created file C.ts",
          "command failed with exit code 1",
        ].join("\n"),
        input_json: JSON.stringify({ command: "x" }),
        file_paths: ["f.ts"],
        outcome: "error",
        error_preview: "stderr",
      });
      const facts = extractor.extract(obs);
      expect(facts.length).toBeGreaterThan(0);
      for (const fact of facts) {
        expect(fact.confidence).toBeGreaterThanOrEqual(0);
        expect(fact.confidence).toBeLessThanOrEqual(1);
      }
    });
  });
});
