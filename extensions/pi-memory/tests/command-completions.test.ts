import { describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { getMemoryArgumentCompletions } from "../command-completions.ts";

describe("memory — autocomplete", () => {
	it("sugere info no nível superior", () => {
		expect(getMemoryArgumentCompletions("")?.map((item) => item.value)).toEqual(["info"]);
		expect(getMemoryArgumentCompletions("in")?.map((item) => item.value)).toEqual(["info"]);
	});

	it("não sugere comandos desconhecidos", () => {
		expect(getMemoryArgumentCompletions("set")).toBeNull();
		expect(getMemoryArgumentCompletions("unknown")).toBeNull();
	});
});
