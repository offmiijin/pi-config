import { describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { availableAuthenticatedModels } from "../tools/config.ts";

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

	it("respeita o conjunto de modelos limitado pela sessão", () => {
		const models = availableAuthenticatedModels({
			modelRegistry: {
				getAvailable: () => [{ provider: "openai", id: "not-scoped" }],
				hasConfiguredAuth: () => true,
			},
			scopedModels: [
				{ model: { provider: "anthropic", id: "scoped" } },
				{ model: { provider: "openai", id: "not-scoped" } },
			],
			ui: {} as never,
			mode: "tui",
		});

		expect(models.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"anthropic/scoped",
			"openai/not-scoped",
		]);
	});
});
