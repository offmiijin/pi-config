import { describe, expect, it } from "vitest";
import { getWebSearchArgumentCompletions } from "../command-completions";

describe("web_search — autocomplete", () => {
	it("sugere comandos de nível superior", () => {
		const suggestions = getWebSearchArgumentCompletions("");
		expect(suggestions?.map((item) => item.value)).toEqual(["config", "help"]);
	});

	it("sugere providers após config", () => {
		const suggestions = getWebSearchArgumentCompletions("config ");
		expect(suggestions?.map((item) => item.value)).toContain("config renderer");
		expect(suggestions?.map((item) => item.value)).toContain("config tavily");
	});

	it("filtra renderer e oferece instalação/status/modos", () => {
		const suggestions = getWebSearchArgumentCompletions("config renderer ");
		expect(suggestions?.map((item) => item.value)).toEqual([
			"config renderer install",
			"config renderer status",
			"config renderer auto",
			"config renderer never",
			"config renderer required",
		]);
	});

	it("retorna null para chaves de provider", () => {
		expect(getWebSearchArgumentCompletions("config tavily ")).toBeNull();
	});
});
