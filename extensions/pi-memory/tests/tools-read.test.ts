/**
 * pi-memory — Tests: tool memory_read.
 *
 * Garante que a tool retorna o markdown canônico integral e não permite
 * leitura de caminhos fora das memórias ativas do projeto.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MEMORIES_ROOT } from "../constants.ts";
import { ensureFileDir } from "../session.ts";
import { registerMemoryRead } from "../tools/read.ts";
import type { ToolState } from "../tools/state.ts";

interface ToolDef {
	execute: (
		...args: unknown[]
	) => Promise<{ content: { type: string; text: string }[]; details?: Record<string, unknown> }>;
}

function captureTool(state: ToolState): ToolDef {
	let definition: ToolDef | undefined;
	const fakePi = {
		registerTool: (tool: ToolDef) => {
			definition = tool;
		},
	};
	registerMemoryRead(fakePi as never, state);
	if (!definition) throw new Error("registerTool não capturou a definição");
	return definition;
}

let projectId: string;
let relativePath: string;
let markdown: string;
let state: ToolState;

beforeAll(() => {
	projectId = `__test_memory_read_${Date.now()}`;
	relativePath = `projects/${projectId}/gotchas/fonte.md`;
	markdown = [
		"---",
		`context: fonte-${projectId}`,
		"type: gotchas",
		"scope: project",
		"confidence: 0.8",
		'memory_id: "mem-read-test"',
		"---",
		"",
		"# Fonte da verdade",
		"",
		"Conteúdo completo da memória, incluindo frontmatter.",
		"",
	].join("\n");
	const filePath = join(MEMORIES_ROOT, relativePath);
	ensureFileDir(filePath);
	writeFileSync(filePath, markdown);

	state = {
		projectId,
		currentSessionHash: "session",
		consecutiveEmptySearches: 0,
		cachedIndexText: null,
		index: null,
		pipeline: null,
		worker: null,
		retention: null,
		retentionScheduler: null,
	};
});

afterAll(() => {
	rmSync(join(MEMORIES_ROOT, "projects", projectId), { recursive: true, force: true });
});

describe("memory_read", () => {
	it("retorna o markdown integral pelo caminho exibido na busca", async () => {
		const tool = captureTool(state);
		const result = await tool.execute("id", { path: `memories/${relativePath}` });

		expect(result.content[0].text).toBe(markdown);
		expect(result.details?.path).toBe(relativePath);
		expect(result.details?.source).toBe("markdown");
		expect(result.details?.complete).toBe(true);
	});

	it("rejeita caminho inseguro e memória inativa", async () => {
		const tool = captureTool(state);
		const unsafe = await tool.execute("id", { path: "../../etc/passwd" });
		expect(unsafe.details?.error).toBe("invalid_path");

		const inactive = await tool.execute("id", {
			path: `memories/projects/${projectId}/gotchas/inexistente.md`,
		});
		expect(inactive.details?.error).toBe("memory_not_found");
	});
});
