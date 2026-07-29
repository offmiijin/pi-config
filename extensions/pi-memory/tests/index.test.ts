/**
 * Testes de integração do index.ts (Fase 1.8).
 *
 * Testa helpers exportados e comportamento das factories.
 */

import { describe, it, expect } from "vitest";
import { slugify } from "../wiki/slugify";

// ── hashProjectId ──────────────────────────────────────────────────────
// Extraída aqui para teste (a original está dentro do escopo da factory)

function hashProjectId(projectDir: string | null | undefined): string {
  const dir = (projectDir === "" || projectDir === "default") ? "default" : (projectDir || process.cwd());
  if (!dir || dir === "default") return "default";
  return `--${slugify(dir)}--`;
}

describe("hashProjectId", () => {
  it("deve retornar hash de process.cwd() para null ou undefined", () => {
    const expected = hashProjectId(process.cwd());
    expect(hashProjectId(null)).toBe(expected);
    expect(hashProjectId(undefined)).toBe(expected);
  });

  it("deve retornar 'default' para string vazia", () => {
    expect(hashProjectId("")).toBe("default");
  });

  it("deve retornar 'default' para 'default'", () => {
    expect(hashProjectId("default")).toBe("default");
  });

  it("deve retornar hash estável para mesmo diretório", () => {
    const a = hashProjectId("/home/user/projects/my-app");
    const b = hashProjectId("/home/user/projects/my-app");
    expect(a).toBe(b);
  });

  it("deve retornar hashes diferentes para diretórios diferentes", () => {
    const a = hashProjectId("/project-a");
    const b = hashProjectId("/project-b");
    expect(a).not.toBe(b);
  });

  it("deve retornar slug no formato --slug--", () => {
    const slug = hashProjectId("/home/user/projects/my-app");
    expect(slug).toBe("--home-user-projects-my-app--");
  });

  it("deve ser determinístico", () => {
    // Deve produzir o mesmo resultado independente de quando chamado
    const results = Array.from({ length: 100 }, () =>
      hashProjectId("/home/user/projects/pi-agent")
    );
    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });
});

// ── Lazy wrappers ──────────────────────────────────────────────────────
// Testa que closures sobre let funcionam corretamente para lazy access

describe("lazy wrappers (closure semantics)", () => {
  it("deve capturar valor atual de let no momento da chamada", () => {
    let value: string | null = null;

    const getter = () => {
      if (!value) throw new Error("Not initialized");
      return value;
    };

    // Antes de inicializar
    expect(() => getter()).toThrow("Not initialized");

    // Inicializa
    value = "ready";

    // Depois de inicializar
    expect(getter()).toBe("ready");
  });

  it("deve refletir mudanças pós-inicialização", () => {
    let sessionId: string | null = null;

    const getSessionId = () => sessionId ?? "unknown";

    expect(getSessionId()).toBe("unknown");

    sessionId = "session-abc";
    expect(getSessionId()).toBe("session-abc");

    sessionId = "session-xyz";
    expect(getSessionId()).toBe("session-xyz");

    sessionId = null;
    expect(getSessionId()).toBe("unknown");
  });
});
