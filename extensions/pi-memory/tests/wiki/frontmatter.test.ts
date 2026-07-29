/**
 * Testes do módulo frontmatter.
 */
import { describe, it, expect } from "vitest";
import { parseFrontmatter, buildFrontmatter, validateFrontmatter } from "../../wiki/frontmatter";
import type { Frontmatter } from "../../wiki/frontmatter";

describe("validateFrontmatter", () => {
  it("deve validar frontmatter completo", () => {
    const fm = validateFrontmatter({
      type: "decision",
      scope: "project",
      title: "Hexagonal Architecture",
    });
    expect(fm.type).toBe("decision");
    expect(fm.scope).toBe("project");
    expect(fm.title).toBe("Hexagonal Architecture");
    expect(fm.confidence).toBe(0.5); // default
    expect(fm.status).toBe("active"); // default
    expect(fm.pinned).toBe(false); // default
    expect(fm.tags).toEqual([]); // default
    expect(fm.created).toBeTruthy();
    expect(fm.updated).toBeTruthy();
  });

  it("deve validar com todos os campos", () => {
    const fm = validateFrontmatter({
      type: "lesson",
      scope: "global",
      title: "Timeout OAuth",
      tags: ["oauth", "timeout"],
      confidence: 0.9,
      status: "draft",
      pinned: true,
      supersedes: "lessons/old-timeout.md",
      source_observations: ["uuid-1", "uuid-2"],
    });
    expect(fm.type).toBe("lesson");
    expect(fm.scope).toBe("global");
    expect(fm.title).toBe("Timeout OAuth");
    expect(fm.tags).toEqual(["oauth", "timeout"]);
    expect(fm.confidence).toBe(0.9);
    expect(fm.status).toBe("draft");
    expect(fm.pinned).toBe(true);
    expect(fm.supersedes).toBe("lessons/old-timeout.md");
    expect(fm.source_observations).toEqual(["uuid-1", "uuid-2"]);
  });

  it("deve lançar erro se type faltar", () => {
    expect(() => validateFrontmatter({
      scope: "project",
      title: "Foo",
    })).toThrow("type é obrigatório");
  });

  it("deve lançar erro se type inválido", () => {
    expect(() => validateFrontmatter({
      type: "invalid",
      scope: "project",
      title: "Foo",
    })).toThrow("type inválido");
  });

  it("deve lançar erro se scope inválido", () => {
    expect(() => validateFrontmatter({
      type: "decision",
      scope: "user",
      title: "Foo",
    })).toThrow("scope inválido");
  });

  it("deve lançar erro se title vazio", () => {
    expect(() => validateFrontmatter({
      type: "decision",
      scope: "project",
      title: "",
    })).toThrow("title é obrigatório");
  });

  it("deve lançar erro se confidence fora do range", () => {
    expect(() => validateFrontmatter({
      type: "decision",
      scope: "project",
      title: "Foo",
      confidence: 1.5,
    })).toThrow("confidence deve ser número entre 0 e 1");
  });

  it("deve lançar erro se status inválido", () => {
    expect(() => validateFrontmatter({
      type: "decision",
      scope: "project",
      title: "Foo",
      status: "deleted",
    })).toThrow("status inválido");
  });

  it("deve lançar erro se tags não for array", () => {
    expect(() => validateFrontmatter({
      type: "decision",
      scope: "project",
      title: "Foo",
      tags: "not-array",
    })).toThrow("tags deve ser um array");
  });

  it("deve lançar erro com múltiplos erros", () => {
    expect(() => validateFrontmatter({})).toThrow();
  });
});

describe("parseFrontmatter", () => {
  it("deve parsear frontmatter completo", () => {
    const md = `---
type: decision
scope: project
title: Hexagonal Architecture
tags: [architecture, hexagonal]
confidence: 0.85
status: active
pinned: false
created: 2026-07-29T12:00:00Z
updated: 2026-07-29T12:00:00Z
---

# Hexagonal Architecture

Body content here.`;

    const result = parseFrontmatter(md);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.type).toBe("decision");
    expect(result!.frontmatter.scope).toBe("project");
    expect(result!.frontmatter.title).toBe("Hexagonal Architecture");
    expect(result!.frontmatter.tags).toEqual(["architecture", "hexagonal"]);
    expect(result!.frontmatter.confidence).toBe(0.85);
    expect(result!.frontmatter.status).toBe("active");
    expect(result!.frontmatter.pinned).toBe(false);
    expect(result!.frontmatter.created).toBe("2026-07-29T12:00:00Z");
    expect(result!.frontmatter.updated).toBe("2026-07-29T12:00:00Z");
    expect(result!.body).toBe("# Hexagonal Architecture\n\nBody content here.");
  });

  it("deve retornar null se não tem frontmatter", () => {
    const md = "# Apenas body\n\nSem frontmatter.";
    expect(parseFrontmatter(md)).toBeNull();
  });

  it("deve retornar null se frontmatter não fechado", () => {
    const md = "---\ntype: decision\nscope: project\ntitle: Foo\n";
    expect(parseFrontmatter(md)).toBeNull();
  });

  it("deve parsear frontmatter com arrays vazios", () => {
    const md = `---
type: decision
scope: project
title: Foo
tags: []
confidence: 0.5
status: active
pinned: false
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---`;
    const result = parseFrontmatter(md);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.tags).toEqual([]);
  });

  it("deve parsear body vazio", () => {
    const md = `---
type: decision
scope: project
title: Foo
confidence: 0.5
status: active
pinned: false
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---`;
    const result = parseFrontmatter(md);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("");
  });
});

describe("buildFrontmatter", () => {
  it("deve construir markdown completo", () => {
    const fm: Frontmatter = {
      type: "decision",
      scope: "project",
      title: "Hexagonal Architecture",
      tags: ["architecture"],
      confidence: 0.85,
      status: "active",
      pinned: false,
      created: "2026-07-29T12:00:00Z",
      updated: "2026-07-29T12:00:00Z",
    };

    const md = buildFrontmatter(fm, "# Body\n\nContent.");

    // Verifica que o resultado pode ser parseado de volta
    const parsed = parseFrontmatter(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.title).toBe("Hexagonal Architecture");
    expect(parsed!.frontmatter.tags).toEqual(["architecture"]);
    expect(parsed!.body).toBe("# Body\n\nContent.");
  });

  it("deve incluir campos opcionais quando presentes", () => {
    const fm: Frontmatter = {
      type: "lesson",
      scope: "global",
      title: "Timeout",
      tags: [],
      confidence: 0.9,
      status: "active",
      pinned: true,
      supersedes: "lessons/old.md",
      source_observations: ["uuid-1"],
      created: "2026-07-29T12:00:00Z",
      updated: "2026-07-29T12:00:00Z",
    };

    const md = buildFrontmatter(fm, "Body");
    expect(md).toContain("supersedes: lessons/old.md");
    expect(md).toContain("source_observations: [uuid-1]");
  });
});
