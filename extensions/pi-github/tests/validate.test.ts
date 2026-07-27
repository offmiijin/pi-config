/**
 * Tests for tools/validate.ts
 *
 * Covers: buildTitle, validateTitle, VALID_TYPES
 */

import { describe, it, expect } from "vitest";
import { buildTitle, validateTitle, VALID_TYPES } from "../tools/validate";

// ---------------------------------------------------------------------------
// buildTitle
// ---------------------------------------------------------------------------
describe("buildTitle", () => {
	it("builds basic title with type, scope, and description", () => {
		const result = buildTitle({
			type: "feat",
			scope: "auth",
			title: "Adiciona login com JWT",
		});
		expect(result).toBe("feat(auth): Adiciona login com JWT");
	});

	it("includes task number when provided", () => {
		const result = buildTitle({
			type: "fix",
			scope: "api/orders",
			title: "Corrige validação de cupom",
			taskNumber: 123,
		});
		expect(result).toBe("fix(api/orders): Corrige validação de cupom #123");
	});

	it("adds breaking indicator when breaking is true", () => {
		const result = buildTitle({
			type: "refactor",
			scope: "checkout",
			title: "Remove campo obsoleto",
			breaking: true,
		});
		expect(result).toBe("refactor(checkout)!: Remove campo obsoleto");
	});

	it("combines breaking and task number", () => {
		const result = buildTitle({
			type: "feat",
			scope: "auth",
			title: "Nova rota de login",
			breaking: true,
			taskNumber: "ABC123",
		});
		expect(result).toBe("feat(auth)!: Nova rota de login #ABC123");
	});

	it("accepts string task number", () => {
		const result = buildTitle({
			type: "chore",
			scope: "docker",
			title: "Atualiza imagem base",
			taskNumber: "dsccw4",
		});
		expect(result).toBe("chore(docker): Atualiza imagem base #dsccw4");
	});

	it("trims scope whitespace", () => {
		const result = buildTitle({
			type: "docs",
			scope: "  readme  ",
			title: "Adiciona instruções de setup",
		});
		expect(result).toBe("docs(readme): Adiciona instruções de setup");
	});

	it("throws when scope is empty string", () => {
		expect(() =>
			buildTitle({
				type: "feat",
				scope: "",
				title: "Test",
			}),
		).toThrow("Escopo é obrigatório");
	});

	it("throws when scope is whitespace only", () => {
		expect(() =>
			buildTitle({
				type: "feat",
				scope: "   ",
				title: "Test",
			}),
		).toThrow("Escopo é obrigatório");
	});
});

// ---------------------------------------------------------------------------
// validateTitle
// ---------------------------------------------------------------------------
describe("validateTitle", () => {
	it("validates a correct title", () => {
		expect(validateTitle("feat(auth): Adiciona login")).toEqual({
			valid: true,
		});
	});

	it("validates title with breaking change", () => {
		expect(validateTitle("feat(auth)!: Remove endpoint")).toEqual({
			valid: true,
		});
	});

	it("validates title with task number", () => {
		expect(validateTitle("fix(api): Corrige bug #123")).toEqual({
			valid: true,
		});
	});

	it("rejects title without type", () => {
		expect(validateTitle("Adiciona login").valid).toBe(false);
	});

	it("rejects title without scope", () => {
		expect(validateTitle("feat: Adiciona login").valid).toBe(false);
	});

	it("rejects title without description", () => {
		expect(validateTitle("feat(auth):").valid).toBe(false);
	});

	it("rejects empty string", () => {
		expect(validateTitle("").valid).toBe(false);
	});

	it("rejects invalid type", () => {
		expect(validateTitle("invalid(auth): description").valid).toBe(false);
	});

	it("accepts all valid types", () => {
		for (const type of VALID_TYPES) {
			const result = validateTitle(`${type}(scope): description`);
			expect(result.valid).toBe(true);
		}
	});

	it("returns error message with format hint when invalid", () => {
		const result = validateTitle("bad title");
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Conventional Commits");
		expect(result.error).toContain("tipo(escopo)");
	});
});