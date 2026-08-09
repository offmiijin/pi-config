/**
 * pi-memory — Tests: normalização de evidências (Fase 1).
 *
 * Usa diretório e banco temporários (mkdtemp) — nunca toca em produção.
 * Testa: parsing do JSONL, branch, sanitização, matriz de relevância por
 * tool, dedup intra-episódio e o fluxo normalizeEpisode → pipeline.
 */

import { after as afterAll, before as beforeAll, describe, it } from "node:test";
import { expect } from "./expect-shim.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	PipelineDB,
	type NewEpisode,
} from "../pipeline.ts";
import {
	buildBranch,
	classifyToolCall,
	extractEpisodeEvidence,
	extractText,
	hasSecret,
	normalizeEpisode,
	normalizePendingEpisodes,
	readSessionEntries,
	sanitizeEvidenceText,
	truncateText,
	type SessionEntry,
} from "../evidence.ts";

let tmpDir: string;
let dbPath: string;
let sessionFile: string;

function sessionLine(entry: Record<string, unknown>): string {
	return JSON.stringify(entry) + "\n";
}

/** Sessão fixture: prompt → edit → bash com erro → resposta → correção → resposta. */
function writeFixtureSession(): void {
	const lines = [
		sessionLine({ type: "session", version: 3, id: "sess-uuid", cwd: "/tmp" }),
		sessionLine({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "Implemente a fase 1" } }),
		sessionLine({
			type: "message", id: "e2", parentId: "e1",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc1", name: "edit", arguments: { path: "/tmp/a.ts", edits: [{ oldText: "const a = 1", newText: "const a = 2" }] } },
				],
			},
		}),
		sessionLine({
			type: "message", id: "e3", parentId: "e2",
			message: { role: "toolResult", toolCallId: "tc1", toolName: "edit", content: [{ type: "text", text: "Successfully replaced 1 block" }], isError: false },
		}),
		sessionLine({
			type: "message", id: "e4", parentId: "e3",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "npm test" } }],
			},
		}),
		sessionLine({
			type: "message", id: "e5", parentId: "e4",
			message: { role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: "FAILED\nAssertionError: expected 1 to equal 2" }], isError: true },
		}),
		sessionLine({
			type: "message", id: "e6", parentId: "e5",
			message: { role: "assistant", content: [{ type: "text", text: "O bug era comparação com valor errado." }] },
		}),
		sessionLine({ type: "message", id: "e7", parentId: "e6", message: { role: "user", content: "não, isso está errado, mude a abordagem" } }),
		sessionLine({
			type: "message", id: "e8", parentId: "e7",
			message: { role: "assistant", content: [{ type: "text", text: "Entendido, refazendo com outra abordagem." }] },
		}),
	];
	writeFileSync(sessionFile, lines.join(""));
}

function makeEpisode(overrides: Partial<NewEpisode> = {}): NewEpisode {
	return {
		projectId: "proj-a",
		sessionId: "sess-1",
		sessionFile,
		startEntryId: "e1",
		endEntryId: "e8",
		leafId: "e8",
		fingerprint: "fp-1",
		tokenEstimate: 100,
		...overrides,
	};
}

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-evidence-"));
	dbPath = join(tmpDir, ".pipeline.sqlite");
	sessionFile = join(tmpDir, "session.jsonl");
	writeFixtureSession();
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("readSessionEntries", () => {
	it("parseia JSONL e ignora o header", () => {
		const entries = readSessionEntries(sessionFile);
		expect(entries.length).toBe(8);
		expect(entries[0].id).toBe("e1");
		expect(entries[0].type).toBe("message");
		expect(entries[0].parentId).toBeNull();
		expect(entries[1].message?.role).toBe("assistant");
	});

	it("retorna [] para arquivo inexistente", () => {
		expect(readSessionEntries(join(tmpDir, "nope.jsonl"))).toHaveLength(0);
	});

	it("pula linhas corrompidas", () => {
		const f = join(tmpDir, "corrupt.jsonl");
		writeFileSync(f, '{"type":"session","id":"x"}\nnot-json\n{"type":"message","id":"a","parentId":null,"message":{"role":"user"}}\n');
		const entries = readSessionEntries(f);
		expect(entries.length).toBe(1);
		expect(entries[0].id).toBe("a");
	});
});

describe("buildBranch", () => {
	it("reconstrói da folha à raiz em ordem root-first", () => {
		const entries = readSessionEntries(sessionFile);
		const branch = buildBranch(entries, "e8");
		expect(branch.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"]);
	});

	it("não entra em loop com parentId corrompido", () => {
		const entries: SessionEntry[] = [
			{ type: "message", id: "a", parentId: "b", message: { role: "user" } },
			{ type: "message", id: "b", parentId: "a", message: { role: "user" } },
		];
		const branch = buildBranch(entries, "b");
		expect(branch.length).toBe(2);
	});
});

describe("hasSecret (determinístico)", () => {
	it("detecta segredo consistentemente em chamadas repetidas", () => {
		const s = "api_key=abcdefghijk";
		// Bug antigo: regex com flag g alternava true/false (lastIndex).
		expect([hasSecret(s), hasSecret(s), hasSecret(s), hasSecret(s)]).toEqual([true, true, true, true]);
	});

	it("retorna false para texto comum", () => {
		expect(hasSecret("o código quebrava com undefined")).toBeFalse();
	});
});

describe("sanitizeEvidenceText", () => {
	it("redige chaves e tokens", () => {
		const { text, redacted } = sanitizeEvidenceText(
			"chave sk-abcdefghijklmnopqrstuvwxyz123 e ghp_abcdefghijklmnopqrstuvwxyz123456",
		);
		expect(redacted).toBeTrue();
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain("sk-");
		expect(text).not.toContain("ghp_");
	});

	it("redige api_key/password com valor", () => {
		const { text, redacted } = sanitizeEvidenceText('api_key: "super-secret-value-123"');
		expect(redacted).toBeTrue();
		expect(text).toContain("[REDACTED]");
	});

	it("não redige texto comum", () => {
		const { redacted } = sanitizeEvidenceText("o código quebrava com undefined");
		expect(redacted).toBeFalse();
	});

	it("redige URL de conexão com credenciais (DATABASE_URL)", () => {
		const { text, redacted } = sanitizeEvidenceText(
			"postgres://usuario:senha123@localhost:5432/appdb?sslmode=require",
		);
		expect(redacted).toBeTrue();
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain("senha123");
	});

	it("redige chave privada PEM multilinha", () => {
		const pem = [
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEpAIBAAKCAQEA1...dados da chave...",
			"-----END RSA PRIVATE KEY-----",
		].join("\n");
		const { text, redacted } = sanitizeEvidenceText(pem);
		expect(redacted).toBeTrue();
		expect(text).not.toContain("PRIVATE KEY");
		expect(text).toContain("[REDACTED]");
	});

	it("redige Authorization: Basic ...", () => {
		const { text, redacted } = sanitizeEvidenceText(
			"curl -H 'Authorization: Basic dXNlcjpwYXNz' https://api.exemplo.com",
		);
		expect(redacted).toBeTrue();
		expect(text).not.toContain("dXNlcjpwYXNz");
	});

	it("redige valor curto de api_key/password (mínimo 4 chars)", () => {
		const { text, redacted } = sanitizeEvidenceText("password: 1234");
		expect(redacted).toBeTrue();
		expect(text).not.toContain("1234");
	});

	it("não redige URL pública nem ssh://git@ (sem credenciais)", () => {
		expect(
			sanitizeEvidenceText("git remote: https://github.com/org/repo.git").redacted,
		).toBeFalse();
		expect(
			sanitizeEvidenceText("clone ssh://git@github.com/org/repo.git").redacted,
		).toBeFalse();
	});
});

describe("truncateText", () => {
	it("trunca com marcador e não corta texto curto", () => {
		const short = truncateText("curto", 50);
		expect(short).toBe("curto");
		const long = truncateText("x".repeat(100), 50);
		expect(long.length).toBeLessThan(100);
		expect(long).toContain("truncated");
	});
});

describe("extractText", () => {
	it("lida com string e blocos", () => {
		expect(extractText("olá")).toBe("olá");
		expect(extractText([{ type: "text", text: "a" }, { type: "thinking", thinking: "..." }])).toBe("a");
	});
});

describe("classifyToolCall", () => {
	it("edit → code-change com path e trechos", () => {
		const ev = classifyToolCall({
			name: "edit",
			args: { path: "/tmp/a.ts", edits: [{ oldText: "const a = 1", newText: "const a = 2" }] },
			resultText: "ok",
			isError: false,
		});
		expect(ev?.kind).toBe("code-change");
		expect(ev?.payload.path).toBe("/tmp/a.ts");
		expect(ev?.payload.text).toContain("const a = 2");
		expect(ev?.priority).toBe(2);
	});

	it("read/grep/find/ls/web_fetch → null (descartadas)", () => {
		for (const name of ["read", "grep", "find", "ls", "web_fetch"]) {
			expect(classifyToolCall({ name, args: {}, resultText: "x", isError: false })).toBeNull();
		}
	});

	it("bash com erro → prioridade 2 + comando preservado", () => {
		const ev = classifyToolCall({
			name: "bash",
			args: { command: "npm test" },
			resultText: "FAILED\n1 failed",
			isError: true,
		});
		expect(ev?.kind).toBe("command");
		expect(ev?.isError).toBeTrue();
		expect(ev?.priority).toBe(2);
		expect(ev?.payload.command).toBe("npm test");
		expect(ev?.payload.exitCode).toBe(1);
	});

	it("web_search → query + títulos", () => {
		const ev = classifyToolCall({
			name: "web_search",
			args: { query: "cache invalidation" },
			resultText: "## Results\n1. **Cache Invalidation**\n   https://x",
			isError: false,
		});
		expect(ev?.kind).toBe("research");
		expect(ev?.payload.text).toContain("cache invalidation");
		expect(ev?.payload.text).toContain("Cache Invalidation");
	});
});

describe("extractEpisodeEvidence", () => {
	it("classifica o episódio fixture completo", () => {
		const entries = readSessionEntries(sessionFile);
		const range = buildBranch(entries, "e8").slice(0, 8);
		const evidence = extractEpisodeEvidence(range);

		const kinds = evidence.map((e) => e.kind);
		expect(kinds).toContain("prompt"); // e1
		expect(kinds).toContain("code-change"); // e2
		expect(kinds).toContain("command"); // e4
		expect(kinds).toContain("response"); // e6, e8
		expect(kinds).toContain("correction"); // e7

		const edit = evidence.find((e) => e.toolName === "edit");
		expect(edit?.payload.path).toBe("/tmp/a.ts");

		const bash = evidence.find((e) => e.toolName === "bash");
		expect(bash?.isError).toBeTrue();
		expect(bash?.priority).toBe(2);
		expect(bash?.payload.text).toContain("AssertionError");

		const correction = evidence.find((e) => e.kind === "correction");
		expect(correction?.priority).toBe(2);
		expect(correction?.payload.text).toContain("errado");

		// toolResults não viram evidência direta (só via toolCall)
		expect(evidence.filter((e) => e.kind === "tool").length).toBe(0);
	});

	it("descarta thinking e images", () => {
		const entries: SessionEntry[] = [
			{
				type: "message", id: "a", parentId: null,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "pensamento privado" },
						{ type: "image", data: "base64", mimeType: "image/png" },
						{ type: "text", text: "resposta final" },
					],
				},
			},
		];
		const evidence = extractEpisodeEvidence(entries);
		expect(evidence).toHaveLength(1);
		expect(evidence[0].kind).toBe("response");
		expect(evidence[0].payload.text).not.toContain("pensamento privado");
	});

	it("mesma path editada de novo → só a última fica", () => {
		const entries: SessionEntry[] = [
			{
				type: "message", id: "a", parentId: null,
				message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { path: "x.ts", edits: [{ oldText: "v1", newText: "v2" }] } }] },
			},
			{ type: "message", id: "b", parentId: "a", message: { role: "toolResult", toolCallId: "t1", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false } },
			{
				type: "message", id: "c", parentId: "b",
				message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "edit", arguments: { path: "x.ts", edits: [{ oldText: "v3", newText: "v4" }] } }] },
			},
			{ type: "message", id: "d", parentId: "c", message: { role: "toolResult", toolCallId: "t2", toolName: "edit", content: [{ type: "text", text: "ok" }], isError: false } },
		];
		const evidence = extractEpisodeEvidence(entries);
		expect(evidence).toHaveLength(1);
		expect(evidence[0].payload.text).toContain("v4");
		expect(evidence[0].payload.text).not.toContain("v2");
	});

	it("repetição idêntica de bash → pula", () => {
		const mkBash = (id: string, parentId: string | null, callId: string): SessionEntry[] => [
			{
				type: "message", id, parentId,
				message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }] },
			},
			{ type: "message", id: `${id}r`, parentId: id, message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false } },
		];
		const entries = [...mkBash("a", null, "c1"), ...mkBash("b", "ar", "c2")];
		const evidence = extractEpisodeEvidence(entries);
		expect(evidence).toHaveLength(1);
	});

	it("compaction → contexto resumido", () => {
		const entries: SessionEntry[] = [
			{ type: "compaction", id: "c", parentId: null, summary: "Usuário pediu refatoração do módulo X" },
		];
		const evidence = extractEpisodeEvidence(entries);
		expect(evidence).toHaveLength(1);
		expect(evidence[0].kind).toBe("context");
	});
});

describe("normalizeEpisode → PipelineDB", () => {
	it("normaliza episódio com evidências e persiste no banco", () => {
		const p = new PipelineDB(dbPath);
		p.open();
		const episodeId = p.insertEpisode(makeEpisode());
		const episode = p.getEpisode(episodeId)!;
		expect(episode.status).toBe("pending");

		const result = normalizeEpisode(p, episode);
		expect(result.status).toBe("normalized");
		expect(result.inserted).toBeGreaterThanOrEqual(5);

		const stored = p.getEpisode(episodeId)!;
		expect(stored.status).toBe("normalized");

		const evidence = p.listEvidenceByEpisode(episodeId);
		expect(evidence.length).toBe(result.inserted);
		const edit = evidence.find((e) => e.toolName === "edit");
		expect(edit).toBeDefined();
		const payload = JSON.parse(edit!.payloadJson) as { path?: string };
		expect(payload.path).toBe("/tmp/a.ts");
		const bash = evidence.find((e) => e.toolName === "bash");
		expect(bash?.isError).toBeTrue();
		p.close();
	});

	it("arquivo de sessão ausente → mantém pending (retry do worker)", () => {
		const p = new PipelineDB(dbPath);
		p.open();
		const episodeId = p.insertEpisode(
			makeEpisode({ sessionFile: join(tmpDir, "missing.jsonl"), fingerprint: "fp-missing" }),
		);
		const episode = p.getEpisode(episodeId)!;
		const result = normalizeEpisode(p, episode);
		expect(result.status).toBe("pending");
		expect(result.inserted).toBe(0);
		expect(p.getEpisode(episodeId)!.status).toBe("pending");
		p.close();
	});

	it("episódio só com thinking (zero evidência útil) → ignored", () => {
		const p = new PipelineDB(dbPath);
		p.open();
		const f = join(tmpDir, "noise.jsonl");
		writeFileSync(
			f,
			sessionLine({ type: "session", version: 3, id: "s", cwd: "/tmp" }) +
				sessionLine({
					type: "message", id: "a", parentId: null,
					message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }] },
				}) +
				sessionLine({
					type: "message", id: "b", parentId: "a",
					message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }] },
				}),
		);
		const episodeId = p.insertEpisode(
			makeEpisode({ sessionFile: f, startEntryId: "a", endEntryId: "b", leafId: "b", fingerprint: "fp-noise" }),
		);
		const episode = p.getEpisode(episodeId)!;
		const result = normalizeEpisode(p, episode);
		expect(result.status).toBe("ignored");
		expect(p.getEpisode(episodeId)!.status).toBe("ignored");
		expect(p.countEvidence({ episodeId })).toBe(0);
		p.close();
	});

	it("normalizePendingEpisodes: retry automático — normalizável transita, sem arquivo permanece pending", () => {
		const p = new PipelineDB(dbPath);
		p.open();
		// Projeto isolado — não depende de pendings de outros testes.
		const proj = "proj-pending-retry";
		const ok = p.insertEpisode(
			makeEpisode({ projectId: proj, fingerprint: "fp-batch-ok" }),
		);
		const missing = p.insertEpisode(
			makeEpisode({
				projectId: proj,
				sessionFile: join(tmpDir, "missing-batch.jsonl"),
				fingerprint: "fp-batch-missing",
			}),
		);
		// Sem retry ainda: ambos pending
		expect(p.getEpisode(ok)!.status).toBe("pending");
		expect(p.getEpisode(missing)!.status).toBe("pending");

		const result = normalizePendingEpisodes(p, proj);
		expect(result.normalized).toBe(1);
		expect(result.stillPending).toBe(1);
		expect(p.getEpisode(ok)!.status).toBe("normalized");
		expect(p.getEpisode(missing)!.status).toBe("pending");

		// Idempotente: segunda passada não re-normaliza nem conta de novo
		const again = normalizePendingEpisodes(p, proj);
		expect(again.normalized).toBe(0);
		expect(again.stillPending).toBe(1);
		p.close();
	});
});
