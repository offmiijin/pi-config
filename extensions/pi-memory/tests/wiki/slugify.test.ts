/**
 * Testes do módulo slugify.
 */
import { describe, it, expect } from "vitest";
import { slugify, slugifyPath, slugifyPathByType, resolveUniquePath, typeToDir } from "../../wiki/slugify";

describe("slugify", () => {
  it("deve converter texto simples", () => {
    expect(slugify("Payment API")).toBe("payment-api");
  });

  it("deve remover acentos", () => {
    expect(slugify("Não usar mais")).toBe("nao-usar-mais");
    expect(slugify("Configuração")).toBe("configuracao");
    expect(slugify("Aplicação")).toBe("aplicacao");
  });

  it("deve lowercasar", () => {
    expect(slugify("Hexagonal Architecture")).toBe("hexagonal-architecture");
  });

  it("deve substituir espaços por hífens", () => {
    expect(slugify("foo bar baz")).toBe("foo-bar-baz");
  });

  it("deve substituir caracteres especiais por hífens", () => {
    expect(slugify("foo@bar!baz")).toBe("foo-bar-baz");
  });

  it("deve trimar hífens das bordas", () => {
    expect(slugify("--foo--")).toBe("foo");
    expect(slugify(" foo ")).toBe("foo");
  });

  it("deve limitar a 80 caracteres", () => {
    const long = "a" .repeat(100);
    expect(slugify(long).length).toBe(80);
  });

  it("deve retornar 'untitled' para texto vazio", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("   ")).toBe("untitled");
  });

  it("deve retornar 'untitled' para texto sem caracteres válidos", () => {
    expect(slugify("@#$%")).toBe("untitled");
  });

  it("deve preservar números", () => {
    expect(slugify("0001-hexagonal")).toBe("0001-hexagonal");
  });
});

describe("slugifyPath", () => {
  it("deve gerar path com plural do tipo", () => {
    const result = slugifyPath("decision", "Hexagonal Architecture");
    expect(result).toBe("decisions/hexagonal-architecture.md");
  });
});

describe("slugifyPathByType", () => {
  it("deve gerar path a partir do tipo", () => {
    const result = slugifyPathByType("decision", "Hexagonal Architecture");
    expect(result).toBe("decisions/hexagonal-architecture.md");
  });

  it("deve usar plural correto para lesson", () => {
    const result = slugifyPathByType("lesson", "Timeout OAuth");
    expect(result).toBe("lessons/timeout-oauth.md");
  });
});

describe("typeToDir", () => {
  it("deve pluralizar corretamente", () => {
    expect(typeToDir("decision")).toBe("decisions");
    expect(typeToDir("lesson")).toBe("lessons");
    expect(typeToDir("preference")).toBe("preferences");
    expect(typeToDir("pattern")).toBe("patterns");
    expect(typeToDir("fact")).toBe("facts");
    expect(typeToDir("session")).toBe("sessions");
  });

  it("deve fallback para plural com s", () => {
    expect(typeToDir("unknown")).toBe("unknowns");
  });
});

describe("resolveUniquePath", () => {
  it("deve retornar path original se não há conflito", () => {
    const result = resolveUniquePath("decisions/foo.md", []);
    expect(result).toBe("decisions/foo.md");
  });

  it("deve adicionar -2 se path existe", () => {
    const result = resolveUniquePath("decisions/foo.md", ["decisions/foo.md"]);
    expect(result).toBe("decisions/foo-2.md");
  });

  it("deve incrementar até achar vaga", () => {
    const result = resolveUniquePath("decisions/foo.md", [
      "decisions/foo.md",
      "decisions/foo-2.md",
      "decisions/foo-3.md",
    ]);
    expect(result).toBe("decisions/foo-4.md");
  });

  it("deve aceitar Set como argumento", () => {
    const result = resolveUniquePath("decisions/foo.md", new Set(["decisions/foo.md"]));
    expect(result).toBe("decisions/foo-2.md");
  });
});
