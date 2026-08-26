import { describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { availableAuthenticatedModels, modelLabels } from "../tools/config.ts";

describe("memory config command", () => {
	it("lista somente modelos autenticados e remove duplicatas", () => {
		const models = availableAuthenticatedModels({
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai", id: "unauthenticated" },
					{ provider: "anthropic", id: "claude", name: "Claude" },
					{ provider: "anthropic", id: "claude", name: "Claude duplicate" },
				],
				hasConfiguredAuth: (model) => model.provider === "anthropic",
			},
			ui: {} as never,
			mode: "tui",
		});

		expect(models.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"anthropic/claude",
		]);
	});

	it("marca o modelo selecionado com uma bolinha", () => {
		expect(modelLabels(
			[{ provider: "anthropic", id: "selected" }, { provider: "openai", id: "other" }],
			{ provider: "anthropic", id: "selected" },
		)).toEqual(["● anthropic/selected", "  openai/other"]);
	});

	it("lista o catálogo completo do Pi, sem limitar por enabledModels", () => {
		const models = availableAuthenticatedModels({
			modelRegistry: {
				getAvailable: () => [
					{ provider: "openai", id: "gpt-full-catalog" },
					{ provider: "anthropic", id: "claude-full-catalog" },
				],
				hasConfiguredAuth: () => true,
			},
			ui: {} as never,
			mode: "tui",
		});

		expect(models.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"anthropic/claude-full-catalog",
			"openai/gpt-full-catalog",
		]);
	});
});
