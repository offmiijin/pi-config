/**
 * pi-memory — Tests: lifecycle do index.ts (wiring dos handlers).
 *
 * Roda a extensão REAL (default export) contra um pi mockado: captura os
 * handlers registrados em pi.on() e as tools em pi.registerTool(), dispara
 * session_start / session_tree / before_agent_start / session_shutdown com
 * cwds temporários (fora de git → projectId __unmanaged_<hash>) e observa o
 * efeito através da tool memory_search (engine sqlite vs rg).
 *
 * Isolamento: PI_CODING_AGENT_DIR aponta para um dir temporário — memories/ e
 * .index.sqlite nunca tocam o agente real (getAgentDir() é lido no momento
 * da chamada; o env precisa estar setado ANTES do import dinâmico).
 *
 * Stubs: index.ts puxa @earendil-works/pi-ai (tools/extract.ts), que depende
 * de `partial-json` ausente no ambiente de teste; e pi-coding-agent, usado só
 * por getAgentDir (constants.ts). module.registerHooks redireciona ambos para
 * módulos mínimos (getAgentDir espelha o comportamento real do env).
 *
 * Só executa sob Node (registerHooks é API Node 22+; Bun não suporta).
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const isNode = typeof ((globalThis as Record<string, unknown>).Bun) === "undefined";

// registerHooks só existe em Node 22+ — skip em Bun (import condicional
// no top-level via top-level await). Em Bun os stubs são desnecessários
// porque o runtime resolve os imports reais.
if (isNode) {
	const { registerHooks } = await import("node:module");

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
						`export const complete = async () => ({ content: [{ type: "text", text: "" }] });`,
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
}

interface MockPi {
	pi: {
		on(event: string, fn: (...args: unknown[]) => unknown): void;
		registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }): void;
		sendUserMessage(): Promise<void>;
	};
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
	tools: Map<string, { name: string; execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }> }>;
	fire(event: string, ...args: unknown[]): Promise<unknown[]>;
}

function createMockPi(): MockPi {
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const tools = new Map();
	const pi = {
		on(event: string, fn: (...args: unknown[]) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) {
			tools.set(tool.name, tool);
		},
		sendUserMessage: async () => {},
	};
	return {
		pi,
		handlers,
		tools,
		async fire(event: string, ...args: unknown[]) {
			const out: unknown[] = [];
			for (const fn of handlers.get(event) ?? []) out.push(await fn(...args));
			return out;
		},
	};
}

function memoryFile(agentDir: string, projectId: string, type: string, name: string): string {
	return join(agentDir, "memories", "projects", projectId, type, name);
}

function makeMemory(abs: string, fm: string, body: string): void {
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, `---\n${fm}---\n\n${body}`);
}

let agentDir: string;
let cwdA!: string;
let cwdB!: string;
let projA: string;
let projB: string;
let mock: MockPi;
let search: { execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }> };

beforeAll(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-memory-ext-"));
	cwdA = mkdtempSync(join(tmpdir(), "pi-memory-projA-"));
	cwdB = mkdtempSync(join(tmpdir(), "pi-memory-projB-"));

	// Env ANTES do import dinâmico — MEMORIES_ROOT/INDEX_DB_PATH resolvem no load.
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const mod = await import("../index.ts");
	const constants = await import("../constants.ts");
	projA = constants.identifyProject(cwdA);
	projB = constants.identifyProject(cwdB);

	mock = createMockPi();
	mod.default(mock.pi as never);

	// Fixtures: um por projeto (termos exclusivos para testar isolamento)
	makeMemory(
		memoryFile(agentDir, projA, "gotchas", "cache.md"),
		"confidence: 0.8\n",
		"## [2026-08-08 10:00:00] Cache\n\nbug de cache invalidação\n",
	);
	makeMemory(
		memoryFile(agentDir, projB, "lessons", "nextjs.md"),
		"confidence: 0.7\n",
		"## [2026-08-08 10:00:00] Next\n\nlição sobre nextjs app router\n",
	);

	search = mock.tools.get("memory_search") as typeof search;
});

afterAll(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwdA, { recursive: true, force: true });
	rmSync(cwdB, { recursive: true, force: true });
});

const ctxA = { cwd: cwdA, sessionManager: { getSessionFile: () => null } };
const ctxB = { cwd: cwdB, sessionManager: { getSessionFile: () => null } };

// Os testes abaixo são ORDENADOS (estado da extensão é compartilhado entre eles).
// Só executa em Node (registerHooks é Node 22+; Bun não suporta).
if (isNode) describe("index.ts lifecycle", () => {
	it("registra os 5 handlers e as 5 tools", () => {
		for (const ev of [
			"session_start",
			"session_tree",
			"before_agent_start",
			"agent_settled",
			"session_shutdown",
		]) {
			expect(mock.handlers.has(ev)).toBeTrue();
		}
		for (const t of ["memory_status", "memory_save", "memory_search", "memory_decay", "memory_extract"]) {
			expect(mock.tools.has(t)).toBeTrue();
		}
	});

	it("busca sem session_start → erro no_active_project", async () => {
		const res = await search.execute("t0", { query: ["cache"] }, undefined, undefined, {});
		expect(res.details.error).toBe("no_active_project");
	});

	it("session_start abre o índice e sincroniza o projeto (engine sqlite)", async () => {
		await mock.fire("session_start", {}, ctxA);

		const res = await search.execute("t1", { query: ["cache"] }, undefined, undefined, {});
		expect(res.details.engine).toBe("sqlite");
		expect(res.details.count).toBeGreaterThanOrEqual(1);
		expect(res.content[0].text).toContain("memories/");
	});

	it("session_tree troca de projeto e sincroniza o novo (isolamento)", async () => {
		await mock.fire("session_tree", {}, ctxB);

		const proj = await search.execute("t2", { query: ["nextjs"], scope: "project" }, undefined, undefined, {});
		expect(proj.details.engine).toBe("sqlite");
		expect(proj.details.count).toBeGreaterThanOrEqual(1);
		expect(proj.content[0].text).toContain(projB);

		// Escopo project = projeto ATUAL (B) — "cache" vive só em A e não vaza
		const iso = await search.execute("t3", { query: ["cache"], scope: "project" }, undefined, undefined, {});
		expect(iso.details.count).toBe(0);
	});

	it("before_agent_start injeta o índice de memórias no system prompt", async () => {
		const [out] = (await mock.fire("before_agent_start", { systemPrompt: "BASE" }, {})) as {
			systemPrompt: string;
		}[];
		expect(out.systemPrompt).toContain("BASE");
		expect(out.systemPrompt).toContain("[pi-memory] Memory index");
	});

	it("session_shutdown fecha o índice — busca cai para o fallback rg", async () => {
		await mock.fire("session_shutdown", {});

		// rg busca em global + projeto atual (B) — "nextjs" está em B
		const res = await search.execute("t4", { query: ["nextjs"] }, undefined, undefined, {});
		expect(res.details.engine).toBe("rg");
		expect(res.details.count).toBeGreaterThanOrEqual(1);
	});
});
