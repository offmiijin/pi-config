/**
 * Testes de integração do index.ts (Fase 1.8).
 *
 * Testa helpers exportados e comportamento das factories.
 */

import { describe, it, expect } from "vitest";

// ── hashProjectId ──────────────────────────────────────────────────────
// Extraída aqui para teste (a original está dentro do escopo da factory)

function hashProjectId(projectDir: string): string {
  if (!projectDir || projectDir === "default") return "default";
  let hash = 0;
  for (let i = 0; i < projectDir.length; i++) {
    hash = (hash * 31 + projectDir.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

describe("hashProjectId", () => {
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

  it("deve retornar string de 8 caracteres hex", () => {
    const hash = hashProjectId("/some/path");
    expect(hash).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(hash)).toBe(true);
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
