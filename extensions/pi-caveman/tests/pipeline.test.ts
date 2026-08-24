import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { compressToolOutput, RECOVERY_TOOL_NAME } from "../transforms/pipeline.ts";
import { RecoveryStore } from "../recovery/store.ts";
import type { CavemanConfig } from "../types.ts";

const roots: string[] = [];
const config: CavemanConfig = {
	enabled: true,
	minBytes: 1,
	maxInputBytes: 2 * 1024 * 1024,
	minSavingsBytes: 1,
	dataDir: "/tmp/pi-caveman-test",
};

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<RecoveryStore> {
	const root = await mkdtemp(`${tmpdir()}/pi-caveman-pipeline-`);
	roots.push(root);
	const store = new RecoveryStore(root);
	await store.open();
	return store;
}

describe("pipeline de resultados", () => {
	it("compacta, salva o original e adiciona handle", async () => {
		const store = await fixture();
		const original = JSON.stringify({ values: Array.from({ length: 80 }, (_, index) => index) }, null, 2);
		const outcome = await compressToolOutput(original, "custom_json_tool", config, store);

		expect(outcome.changed).toBe(true);
		expect(outcome.handle).toMatch(/^ccr_/);
		expect(outcome.content).toContain(`<<ccr:${outcome.handle}>>`);
		expect(await store.get(outcome.handle!)).toBe(original);
		expect(outcome.outputBytes).toBeLessThan(outcome.originalBytes);
	});

	it("ignora tools nativas porque elas são donas da própria saída", async () => {
		const store = await fixture();
		const original = JSON.stringify({ values: Array.from({ length: 80 }, (_, index) => index) }, null, 2);
		for (const toolName of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
			const outcome = await compressToolOutput(original, toolName, config, store);
			expect(outcome.changed, toolName).toBe(false);
			expect(outcome.content, toolName).toBe(original);
			expect(outcome.reason, toolName).toContain("tool nativa");
		}
	});

	it("não recompacta a própria ferramenta de recuperação", async () => {
		const store = await fixture();
		const outcome = await compressToolOutput("conteúdo original", RECOVERY_TOOL_NAME, config, store);
		expect(outcome.changed).toBe(false);
		expect(outcome.content).toBe("conteúdo original");
	});

	it("faz fallback quando a entrada não é suportada", async () => {
		const store = await fixture();
		const original = "texto simples sem estrutura";
		const outcome = await compressToolOutput(original, "read", config, store);
		expect(outcome.changed).toBe(false);
		expect(outcome.content).toBe(original);
	});
});
