/**
 * E2E real do pi-memory: sessão JSONL → evidências → job → LLM REAL →
 * candidatos → validação → commit markdown → índice FTS.
 *
 * Usa o ModelRuntime real (opencode-go/deepseek-v4-flash), PipelineDB real,
 * MemoryIndex real e o processor de extração real do index.ts (mesmos deps).
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { PipelineDB, EPISODE_STATUS, JOB_STATUS } from "../pipeline/pipeline.ts";
import { MemoryIndex, readMemoryDocFromFile, relFromMemoriesRoot } from "../memory/memory-index.ts";
import { normalizePendingEpisodes } from "../pipeline/evidence.ts";
import { PipelineWorker } from "../pipeline/worker.ts";
import { createExtractionProcessor } from "../pipeline/processor.ts";
import { formatExistingMemories } from "../pipeline/extractor.ts";
import { findMemoryFile, parseFrontmatter, saveMemory } from "../memory/memory.ts";

const PROJ = "e2e-project";
const tmp = mkdtempSync(join(tmpdir(), "pi-memory-e2e-"));
const pipelinePath = join(tmp, ".pipeline.sqlite");
const indexPath = join(tmp, ".index.sqlite");
const sessionFile = join(tmp, "session.jsonl");

// ── 1. Sessão JSONL realista: bug fix de cache em PT-BR ────────────────────
const header = { type: "session", version: 3, id: "s-e2e", cwd: "/tmp/proj" };
const a = { type: "message", id: "a", parentId: null, message: { role: "user", content: "o cache está invalidando errado, usuário vê dados velhos depois de salvar" } };
const b = {
	type: "message", id: "b", parentId: "a",
	message: {
		role: "assistant",
		content: [
			{ type: "text", text: "Vou ver como a invalidação funciona." },
			{
				type: "toolCall", id: "t1", name: "read",
				arguments: { path: "src/cache.ts" },
			},
		],
	},
};
const bRes = { type: "message", id: "b1", parentId: "b", message: { role: "tool", content: [{ type: "toolResult", toolCallId: "t1", text: "cache.ts:\nexport function invalidate() {\n  cache.clear();\n}\n\nfunction save(data) {\n  write(data);\n  invalidate();\n}" }] } };
const c = {
	type: "message", id: "c", parentId: "b1",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall", id: "t2", name: "edit",
				arguments: { path: "src/cache.ts", oldText: "write(data);\n  invalidate();", newText: "invalidate();\n  write(data);" },
			},
		],
	},
};
const cRes = { type: "message", id: "c1", parentId: "c", message: { role: "tool", content: [{ type: "toolResult", toolCallId: "t2", text: "edit applied" }] } };
const d = {
	type: "message", id: "d", parentId: "c1",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall", id: "t3", name: "bash",
				arguments: { command: "npm test" },
			},
		],
	},
};
const dRes = { type: "message", id: "d1", parentId: "d", message: { role: "tool", content: [{ type: "toolResult", toolCallId: "t3", isError: true, text: "FAIL src/cache.test.ts — esperava cache vazio após save" }] } };
const e = {
	type: "message", id: "e", parentId: "d1",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall", id: "t4", name: "edit",
				arguments: { path: "src/cache.test.ts", oldText: "expect(cache.isEmpty()).toBeTrue()", newText: "expect(cache.isEmpty()).toBeFalse()" },
			},
		],
	},
};
const eRes = { type: "message", id: "e1", parentId: "e", message: { role: "tool", content: [{ type: "toolResult", toolCallId: "t4", text: "edit applied" }] } };
const f = {
	type: "message", id: "f", parentId: "e1",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Corrigido: invalidação agora acontece ANTES do write, então o cache é repopulado com dados novos. Testes passam." }],
	},
};
const g = { type: "message", id: "g", parentId: "f", message: { role: "user", content: "não, não era isso — o bug é o token de expiração com tempo errado, corrige a TTL" } };
const h = {
	type: "message", id: "h", parentId: "g",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall", id: "t5", name: "edit",
				arguments: { path: "src/cache.ts", oldText: "ttl = 60_000", newText: "ttl = 300_000" },
			},
		],
	},
};
const hRes = { type: "message", id: "h1", parentId: "h", message: { role: "tool", content: [{ type: "toolResult", toolCallId: "t5", text: "edit applied" }] } };
const i = { type: "message", id: "i", parentId: "h1", message: { role: "assistant", content: [{ type: "text", text: "TTL ajustada para 5 minutos. O cache agora expira com o tempo certo." }] } };

writeFileSync(
	sessionFile,
	[header, a, b, bRes, c, cRes, d, dRes, e, eRes, f, g, h, hRes, i]
		.map((l) => JSON.stringify(l))
		.join("\n") + "\n",
);
console.log(`✓ sessão JSONL escrita (${sessionFile})`);

// ── 2. Pipeline + índice reais ──────────────────────────────────────────────
const pipeline = new PipelineDB(pipelinePath);
pipeline.open();
const index = new MemoryIndex(indexPath);
index.open();
index.syncIncremental(PROJ);
console.log("✓ pipeline + índice abertos");

// ── 3. Episódio + normalização (como agent_settled faz) ─────────────────────
const episodeId = pipeline.insertEpisode({
	projectId: PROJ,
	sessionId: "e2e-sess",
	sessionFile,
	startEntryId: "a",
	endEntryId: "i",
	leafId: "i",
	fingerprint: "fp-e2e-real",
	tokenEstimate: 1000,
});
const norm = normalizePendingEpisodes(pipeline, PROJ);
const ep = pipeline.getEpisode(episodeId)!;
const evidence = pipeline.listEvidenceByEpisode(episodeId);
console.log(`✓ episódio ${episodeId}: status ${ep.status} | evidências: ${evidence.length}`);
for (const ev of evidence.slice(0, 20)) {
	console.log(`    [${ev.kind}] ${JSON.parse(ev.payloadJson).text?.slice(0, 70) ?? ""}`);
}

// ── 4. Runtime LLM REAL + deps idênticos ao index.ts ────────────────────────
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const registry = new ModelRegistry(runtime);
const modelRef = registry.find("opencode-go", "deepseek-v4-flash");
if (!modelRef || !registry.hasConfiguredAuth(modelRef)) {
	console.error("✗ modelo real indisponível");
	process.exit(1);
}
console.log("✓ modelo real:", modelRef.id, "| auth ok");

const getModel = async () => {
	const model = registry.find("opencode-go", "deepseek-v4-flash");
	if (!model || !registry.hasConfiguredAuth(model)) return null;
	return {
		provider: "opencode-go",
		id: "deepseek-v4-flash",
		complete: (messages, opts) => registry.complete(model, { messages }, opts),
	};
};
const getRelatedMemories = async (projectId, terms) => {
	if (!index.isOpen || index.needsRebuild || terms.length === 0) return "";
	try {
		const results = index.search({ terms, scope: "all", projectId, limit: 8 });
		return formatExistingMemories(
			results.map((r) => ({
				scope: r.scope, type: r.type, context: r.context,
				confidence: r.confidence, title: r.title, summary: r.summary, snippet: r.snippet,
			})),
		);
	} catch {
		return "";
	}
};
const findExistingMemory = async (projectId, context) => {
	try {
		const fp = findMemoryFile(projectId, context);
		if (!fp) return null;
		const { meta, body } = parseFrontmatter(readFileSync(fp, "utf-8"));
		return {
			context,
			scope: fp.includes("_global") ? "global" : "project",
			type: typeof meta.type === "string" ? meta.type : "",
			confidence: typeof meta.confidence === "number" ? meta.confidence : 0.5,
			summary: typeof meta.summary === "string" ? meta.summary : null,
			content: body.trim(),
		};
	} catch {
		return null;
	}
};
const commitMemory = async (projectId, candidate) => {
	try {
		if (!candidate.type || !candidate.scope || !candidate.title || !candidate.content) {
			return { ok: false, error: "candidato incompleto para commit" };
		}
		const result = saveMemory(projectId, {
			type: candidate.type,
			context: candidate.context,
			title: candidate.title,
			content: candidate.content,
			scope: candidate.scope,
			confidence: candidate.confidence ?? 0.5,
			summary: candidate.summary ?? undefined,
			tags: [],
			evidence: candidate.evidenceIds,
			supersedes: candidate.action === "supersede" ? candidate.supersedes ?? undefined : undefined,
		});
		if (result.action === "error") return { ok: false, error: result.error };
		if (index.isOpen && result.file) {
			try {
				index.syncMutationSafe({
					upsert: [readMemoryDocFromFile(result.file, relFromMemoriesRoot(result.file))],
					remove: (result.archived ?? []).map((p) => relFromMemoriesRoot(p)),
				});
			} catch {
				// degrada — próximo sync reconcilia
			}
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: (err as Error).message ?? String(err) };
	}
};

// ── 5. Job manual + worker real ─────────────────────────────────────────────
const jobId = pipeline.createJob(PROJ, "manual");
const worker = new PipelineWorker(pipeline, {
	processor: createExtractionProcessor({ getModel, getRelatedMemories, findExistingMemory, commitMemory }),
	includeClaimed: true,
	maxAttempts: 2,
	backoffMs: [0, 5000],
});
worker.setProject(PROJ);
worker.start();
console.log(`✓ job ${jobId} criado, worker iniciado — chamada LLM real...`);

// ── 6. Aguarda terminal ─────────────────────────────────────────────────────
const deadline = Date.now() + 180_000;
let job;
while (Date.now() < deadline) {
	job = pipeline.getJob(jobId);
	if (job && (job.status === JOB_STATUS.DONE || job.status === JOB_STATUS.DEAD_LETTER)) break;
	await new Promise((r) => setTimeout(r, 500));
}
await worker.stop();

if (!job) {
	console.error("✗ TIMEOUT — job não terminou");
	process.exit(1);
}
console.log(`✓ job ${jobId}: status ${job.status} | attempts ${job.attempts}`);
console.log(`  error: ${job.error ?? "(nenhum)"}`);
console.log(`  model: ${job.model} | reasoning: ${job.reasoningLevel} | prompt v${job.promptVersion}`);
console.log(`  tokens: ${job.inputTokens} in / ${job.outputTokens} out`);
console.log(`  details: ${job.details}`);
console.log(`  finished: ${job.finishedAt}`);

// ── 7. Verificação dos candidatos ───────────────────────────────────────────
const candidates = pipeline.listCandidatesByJob(jobId);
console.log(`✓ candidatos: ${candidates.length}`);
for (const c of candidates) {
	console.log(`  [${c.status}] ${c.action} ${c.type}/${c.scope}/${c.context} conf=${c.confidence}`);
	if (c.rejectionReason) console.log(`    rejeição: ${c.rejectionReason}`);
}

// ── 8. Verificação das memórias no disco + FTS ──────────────────────────────
const committed = candidates.filter((c) => c.status === "committed");
let memChecks = 0;
for (const c of committed) {
	const fp = findMemoryFile(PROJ, c.context);
	if (!fp) {
		console.log(`  ✗ memória ${c.context}: NÃO encontrada no disco`);
		continue;
	}
	memChecks++;
	const raw = readFileSync(fp, "utf-8");
	const { meta } = parseFrontmatter(raw);
	console.log(`  ✓ memória ${c.context} → ${fp}`);
	console.log(`    frontmatter: revision=${meta.revision} conf=${meta.confidence} summary=${typeof meta.summary === "string" ? meta.summary.slice(0, 60) : "sem"}`);
	// FTS: buscar por termo de conteúdo (context com hífen é tokenizado em
	// partes — "cache-ttl" vira tokens separados no FTS5).
	const term = (typeof meta.summary === "string" ? meta.summary : c.content ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9à-úãõâêîôûç ]/g, " ")
		.trim()
		.split(/\s+/)
		.find((w) => w.length >= 5);
	// O índice chaveia por FILENAME sanitizado (context acentuado é sanitizado
	// em "invalida-o-cache...") — compara contra o basename sem .md.
	const indexedContext = fp.split("/").pop()!.replace(/\.md$/, "");
	const found = term
		? index.search({ terms: [term], scope: "all", projectId: PROJ, limit: 5 })
		: [];
	console.log(`    FTS: ${found.some((r) => r.context === indexedContext) ? "indexada ✓" : "NÃO indexada ✗"}`);
}

// ── 9. memory_status métricas (mesmas queries da tool) ──────────────────────
const pending = pipeline.countEpisodes(PROJ, EPISODE_STATUS.PENDING);
const normalized = pipeline.countEpisodes(PROJ, EPISODE_STATUS.NORMALIZED);
const processed = pipeline.countEpisodes(PROJ, EPISODE_STATUS.PROCESSED);
const jobsDone = pipeline.countJobs(PROJ, JOB_STATUS.DONE);
console.log(`✓ status: episodes pending=${pending} normalized=${normalized} processed=${processed} | jobs done=${jobsDone}`);

console.log("\n=== RESULTADO E2E ===");
console.log(`job: ${job.status} | candidatos: ${candidates.length} | committed: ${committed.length} | memórias em disco+FTS: ${memChecks}`);

// Cleanup — pipeline + índice + sessão + memórias criadas no ROOT REAL
// (saveMemory usa MEMORIES_ROOT de constants.ts).
pipeline.close();
index.close();
rmSync(tmp, { recursive: true, force: true });
rmSync(join("/home/miyake/.pi/agent/memories/projects", PROJ), { recursive: true, force: true });
rmSync(join("/home/miyake/.pi/agent/memories/.history/projects", PROJ), { recursive: true, force: true });
console.log(`✓ limpeza: ${tmp} + memórias e2e removidos`);
