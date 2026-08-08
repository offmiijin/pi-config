/**
 * pi-memory — Tests: tool memory_extract (wiring real com supersedes).
 *
 * Executa o execute() real com LLM stubado via registerHooks
 * (@earendil-works/pi-ai/compat: complete devolve globalThis.__EXTRACT_RESPONSE__)
 * e MEMORIES_ROOT temporário via PI_CODING_AGENT_DIR (getAgentDir real honra o env).
 * Valida que supersedes/consolidate propagam a remoção ao índice na extração.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";

// Stubs registrados antes de qualquer import da extensão — pi-ai depende de
// partial-json (ausente no ambiente de teste); o pi-coding-agent real importa
// `contentText` de pi-ai no topo, então é stubado junto (getAgentDir espelha o
// comportamento real do env). complete devolve resposta controlada via global.
const dataUrl = (body: string) => "data:text/javascript," + encodeURIComponent(body);

registerHooks({
	resolve(specifier, _context, nextResolve) {
		if (specifier === "@earendil-works/pi-ai") {
			return {
				url: dataUrl(`export const uuidv7 = () => "00000000-0000-0000-0000-000000000000";`),
				shortCircuit: true,
			};
		}
		if (specifier === "@earendil-works/pi-ai/compat") {
			return {
				url: dataUrl(
					`export const complete = async () => ({ content: [{ type: "text", text: globalThis.__EXTRACT_RESPONSE__ ?? "" }] });`,
				),
				shortCircuit: true,
			};
		}
		if (specifier === "@earendil-works/pi-coding-agent") {
			return {
				url: dataUrl(
					`import { homedir } from "node:os";
					import { join } from "node:path";
					export const CONFIG_DIR_NAME = ".pi";
					export function getAgentDir() {
						const envDir = process.env.PI_CODING_AGENT_DIR;
						return envDir || join(homedir(), CONFIG_DIR_NAME, "agent");
					}
					export const ExtensionAPI = {};`,
				),
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, _context);
	},
});

interface ToolDef {
	execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; details?: Record<string, unknown> }>;
}

type ExtractToolState = import("../tools/state.ts").ToolState;

describe("memory_extract — supersedes propagam ao índice", () => {
	let proj: string;
	let agentDir: string;
	let cwd: string;
	let MEMORIES_ROOT: string;
	let idx: import("../memory-index.ts").MemoryIndex;
	let readMemoryDocFromFile: typeof import("../memory-index.ts").readMemoryDocFromFile;
	let relFromMemoriesRoot: typeof import("../memory-index.ts").relFromMemoriesRoot;
	let saveMemory: typeof import("../memory.ts").saveMemory;
	let registerMemoryExtract: typeof import("../tools/extract.ts").registerMemoryExtract;

	function makeState(): ExtractToolState {
		return {
			projectId: proj,
			currentSessionHash: "exttest",
			lastPromptedBucket: -1,
			consecutiveEmptySearches: 0,
			cachedIndexText: null,
			index: idx,
		};
	}

	function captureTool(state: ExtractToolState): ToolDef {
		let def: ToolDef | null = null;
		const fakePi = {
			registerTool: (d: ToolDef) => {
				def = d;
			},
		};
		registerMemoryExtract(fakePi as never, state);
		if (!def) throw new Error("registerTool não capturou a definição");
		return def;
	}

	/** Cria arquivo de sessão com observações e devolve o path relativo a sessions/. */
	function writeSession(name: string, obs: string[]): string {
		const rel = `2026-08-08/${name}.md`;
		const abs = join(MEMORIES_ROOT, "projects", proj, "sessions", rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, `# Session ${name} — 2026-08-08\n\n${obs.join("\n")}\n`);
		return rel;
	}

	const ctx = {
		model: { provider: "test", id: "test-model" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
	};

	beforeAll(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-memory-extract-"));
		cwd = mkdtempSync(join(tmpdir(), "pi-memory-extract-cwd-"));
		// Env ANTES do import dinâmico — MEMORIES_ROOT/INDEX_DB_PATH resolvem no load.
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const constants = await import("../constants.ts");
		const memIndex = await import("../memory-index.ts");
		const mem = await import("../memory.ts");
		const extractMod = await import("../tools/extract.ts");

		MEMORIES_ROOT = constants.MEMORIES_ROOT;
		proj = constants.identifyProject(cwd);
		// session_start real chama ensureDirectories antes de abrir o índice —
		// o teste abre direto; garante o dir do banco.
		mkdirSync(MEMORIES_ROOT, { recursive: true });
		idx = new memIndex.MemoryIndex();
		readMemoryDocFromFile = memIndex.readMemoryDocFromFile;
		relFromMemoriesRoot = memIndex.relFromMemoriesRoot;
		saveMemory = mem.saveMemory;
		registerMemoryExtract = extractMod.registerMemoryExtract;

		idx.open();
		idx.rebuild(proj);
	});

	afterAll(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		idx.close();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function indexSaved(result: { file: string }): void {
		idx.upsertDocument(readMemoryDocFromFile(result.file, relFromMemoriesRoot(result.file)));
	}

	it("extração com supersedes remove o antigo do índice", async () => {
		const a = saveMemory(proj, {
			type: "gotchas",
			context: "ext-old",
			title: "Velha",
			content: "token_ext_antigo_xyz",
			scope: "project",
		});
		indexSaved(a);

		const sessionRel = writeSession("sess-1", [
			'## Obs #1 (10:00:00)\nUser: "obs extração"\nTools: (none)\nAssistant: "aprendizado novo"',
		]);
		(globalThis as Record<string, unknown>).__EXTRACT_RESPONSE__ = JSON.stringify({
			memories: [
				{
					type: "lessons",
					context: "ext-new",
					title: "Nova",
					content: "token_ext_novo_xyz",
					scope: "project",
					supersedes: "ext-old",
				},
			],
		});

		const tool = captureTool(makeState());
		const res = await tool.execute("id1", { session_file: sessionRel }, undefined, undefined, ctx);

		expect(res.details!.index).toBe("synced");
		expect(res.details!.count).toBe(1);

		// Antigo fora da FTS; novo buscável
		expect(idx.search({ terms: ["token_ext_antigo_xyz"], projectId: proj })).toHaveLength(0);
		const newHits = idx.search({ terms: ["token_ext_novo_xyz"], projectId: proj });
		expect(newHits.some((r) => r.path.includes("ext-new"))).toBeTrue();

		// Arquivo antigo movido para .supersedes/
		expect(existsSync(join(MEMORIES_ROOT, "projects", proj, "gotchas", "ext-old.md"))).toBeFalse();
		expect(existsSync(join(MEMORIES_ROOT, ".supersedes", "projects", proj, "gotchas", "ext-old.md"))).toBeTrue();
	});

	it("extração sem supersedes preserva memórias existentes", async () => {
		const a = saveMemory(proj, {
			type: "gotchas",
			context: "ext-keep",
			title: "Keep",
			content: "token_ext_keep_xyz",
			scope: "project",
		});
		indexSaved(a);

		const sessionRel = writeSession("sess-2", [
			'## Obs #1 (10:00:00)\nUser: "outra obs"\nTools: (none)\nAssistant: "aprendizado"',
		]);
		(globalThis as Record<string, unknown>).__EXTRACT_RESPONSE__ = JSON.stringify({
			memories: [
				{
					type: "decisions",
					context: "ext-novo2",
					title: "Novo2",
					content: "token_ext_novo2_xyz",
					scope: "project",
				},
			],
		});

		const tool = captureTool(makeState());
		const res = await tool.execute("id2", { session_file: sessionRel }, undefined, undefined, ctx);

		expect(res.details!.index).toBe("synced");
		expect(idx.search({ terms: ["token_ext_keep_xyz"], projectId: proj })).toHaveLength(1);
		expect(
			idx.search({ terms: ["token_ext_novo2_xyz"], projectId: proj }).some((r) => r.path.includes("ext-novo2")),
		).toBeTrue();
	});

	it("extração com índice indisponível: markdowns salvos, index=off", async () => {
		const sessionRel = writeSession("sess-3", [
			'## Obs #1 (10:00:00)\nUser: "obs off"\nTools: (none)\nAssistant: "aprendizado"',
		]);
		(globalThis as Record<string, unknown>).__EXTRACT_RESPONSE__ = JSON.stringify({
			memories: [
				{ type: "gotchas", context: "ext-off", title: "Off", content: "token_ext_off_xyz", scope: "project" },
			],
		});

		const state = makeState();
		state.index = null;
		const tool = captureTool(state);
		const res = await tool.execute("id3", { session_file: sessionRel }, undefined, undefined, ctx);

		expect(res.details!.index).toBe("off");
		expect(res.details!.count).toBe(1);
		expect(existsSync(join(MEMORIES_ROOT, "projects", proj, "gotchas", "ext-off.md"))).toBeTrue();
	});
});
