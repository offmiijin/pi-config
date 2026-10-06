import { describe, expect, it } from "vitest";
import extension from "../index.ts";

describe("entry point do pi-doctor", () => {
	it("registra o comando /doctor e a tool doctor_check", async () => {
		const commands = new Map<string, unknown>();
		const tools = new Map<string, unknown>();
		const handlers = new Map<string, unknown>();
		const pi = {
			registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
			registerTool: (definition: { name: string }) => tools.set(definition.name, definition),
			on: (event: string, handler: unknown) => handlers.set(event, handler),
			sendMessage: () => {},
		};

		await extension(pi as never);

		expect(commands.has("doctor")).toBe(true);
		expect(tools.has("doctor_check")).toBe(true);
		expect(handlers.has("session_start")).toBe(true);
	});
});
