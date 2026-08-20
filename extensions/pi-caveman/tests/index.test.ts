import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory from "../index.ts";

const roots: string[] = [];
const originalHome = process.env.PI_CAVEMAN_HOME;
const originalEnabled = process.env.PI_CAVEMAN_ENABLED;
type TestHandler = (...args: any[]) => any;

afterEach(async () => {
	if (originalHome === undefined) delete process.env.PI_CAVEMAN_HOME;
	else process.env.PI_CAVEMAN_HOME = originalHome;
	if (originalEnabled === undefined) delete process.env.PI_CAVEMAN_ENABLED;
	else process.env.PI_CAVEMAN_ENABLED = originalEnabled;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context() {
	return {
		hasUI: false,
		ui: { notify: () => undefined },
	} as never;
}

async function extensionFixture() {
	const root = await mkdtemp(`${tmpdir()}/pi-caveman-index-`);
	roots.push(root);
	process.env.PI_CAVEMAN_HOME = root;
	process.env.PI_CAVEMAN_ENABLED = "1";
	const handlers = new Map<string, TestHandler>();
	const tools = new Map<string, { execute: TestHandler }>();
	const commands = new Map<string, unknown>();
	const api = {
		on(name: string, handler: TestHandler) { handlers.set(name, handler); },
		registerTool(definition: { name: string; execute: TestHandler }) { tools.set(definition.name, definition); },
		registerCommand(name: string, definition: unknown) { commands.set(name, definition); },
	} as unknown as ExtensionAPI;
	factory(api);
	await handlers.get("session_start")!({}, context());
	return { handlers, tools, commands };
}

describe("integração com Pi", () => {
	it("inicializa o store e compacta o resultado de uma ferramenta", async () => {
		const fixture = await extensionFixture();
		const original = JSON.stringify({ values: Array.from({ length: 400 }, (_, index) => index) }, null, 2);
		const patch = await fixture.handlers.get("tool_result")!({
			toolName: "bash",
			toolCallId: "call-1",
			input: {},
			content: [{ type: "text", text: original }],
			isError: false,
		}, context());

		expect(patch).toMatchObject({ content: [{ type: "text" }] });
		const compacted = (patch as { content: Array<{ text: string }> }).content[0]!.text;
		expect(compacted).toContain("<<ccr:");
	});

	it("registra a ferramenta de recuperação e o comando", async () => {
		const fixture = await extensionFixture();
		expect(fixture.tools.has("caveman_retrieve")).toBe(true);
		expect(fixture.commands.has("caveman")).toBe(true);
	});

	it("mantém o resultado inalterado quando desativado", async () => {
		const fixture = await extensionFixture();
		const command = fixture.commands.get("caveman") as { handler: (args: string, ctx: any) => Promise<void> };
		await command.handler("off", context());
		const original = JSON.stringify({ values: Array.from({ length: 400 }, (_, index) => index) }, null, 2);
		const patch = await fixture.handlers.get("tool_result")!({
			toolName: "bash",
			toolCallId: "call-2",
			input: {},
			content: [{ type: "text", text: original }],
			isError: false,
		}, context());
		expect(patch).toBeUndefined();
	});
});
