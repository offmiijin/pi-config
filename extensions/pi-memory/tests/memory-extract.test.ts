/**
 * pi-memory — Tests: memory-extract.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	countObservations
} from "../session.ts";

import {
	buildExtractionPrompt,
	parseExtractionResult,
	removeProcessedObservations,
	selectObservationsBatch,
	splitObservations
} from "../memory-extract.ts";

describe("buildExtractionPrompt", () => {
	it("includes session content", () => {
		const prompt = buildExtractionPrompt("## Obs #1\nUser: fix bug");
		expect(prompt).toContain("## Obs #1");
		expect(prompt).toContain("fix bug");
	});

	it("includes extraction rules", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("confidence >= 0.5");
		expect(prompt).toContain("Reuse existing context keys");
		expect(prompt).toContain("JSON only");
	});

	it("mentions all 5 memory types", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("gotchas");
		expect(prompt).toContain("_rules");
		expect(prompt).toContain("decisions");
		expect(prompt).toContain("lessons");
		expect(prompt).toContain("patterns");
	});

	it("explains scope rules", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("global");
		expect(prompt).toContain("project");
	});

	it("requires PT-BR memory content", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("PT-BR");
		expect(prompt).toContain("Brazilian Portuguese");
	});

	it("includes existing memories when provided", () => {
		const prompt = buildExtractionPrompt(
			"content",
			"global/_rules/auth (0.8, updated 2026-07-20): \"Tokens expiram em 24h\"\nproject/gotchas/nextjs-router (0.7, updated 2026-08-01): \"params é Promise\"",
		);
		expect(prompt).toContain("Existing memories");
		expect(prompt).toContain("auth");
		expect(prompt).toContain("nextjs-router");
	});

	it("mentions supersedes for existing memories", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("supersedes");
	});

	it("mentions mode consolidate for updates on same context", () => {
		const prompt = buildExtractionPrompt("content");
		expect(prompt).toContain("consolidate");
		expect(prompt).toContain("SAME context key");
	});
});

describe("parseExtractionResult", () => {
	it("parses valid JSON with memories", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "nextjs",
					title: "params is Promise",
					content: "In Next.js...",
					scope: "project",
					confidence: 0.7,
					tags: ["nextjs"],
				},
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].context).toBe("nextjs");
		expect(result[0].type).toBe("gotchas");
		expect(result[0].scope).toBe("project");
		expect(result[0].confidence).toBe(0.7);
		expect(result[0].tags).toEqual(["nextjs"]);
	});

	it("preserves supersedes field", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "new-key",
					title: "New info",
					content: "Better version",
					scope: "project",
					supersedes: "old-key",
				},
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].supersedes).toBe("old-key");
	});

	it("accepts mode consolidate", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "c",
					title: "t",
					content: "x",
					scope: "project",
					mode: "consolidate",
				},
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].mode).toBe("consolidate");
	});

	it("rejects invalid mode", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "c",
					title: "t",
					content: "x",
					scope: "project",
					mode: "overwrite",
				},
			],
		});
		expect(parseExtractionResult(json)).toEqual([]);
	});

	it("handles markdown code fences", () => {
		const json = '```json\n{"memories": [{"type": "lessons", "context": "c", "title": "t", "content": "x", "scope": "global"}]}\n```';
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].context).toBe("c");
	});

	it("returns empty for invalid JSON", () => {
		expect(parseExtractionResult("not json at all")).toEqual([]);
	});

	it("returns empty when memories key missing", () => {
		expect(parseExtractionResult(JSON.stringify({ foo: "bar" }))).toEqual([]);
	});

	it("filters out incomplete memories", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "ok",
					title: "complete",
					content: "full",
					scope: "project",
				},
				{ type: "gotchas", context: "missing content" },
				{ type: "gotchas", context: "c", title: "t", content: "x", scope: "invalid" },
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].context).toBe("ok");
	});

	it("filters memories with non-canonical type", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "ok",
					title: "t",
					content: "c",
					scope: "project",
				},
				// singular — would create a "gotcha/" dir instead of "gotchas/"
				{
					type: "gotcha",
					context: "bad-singular",
					title: "t",
					content: "c",
					scope: "project",
				},
				// without underscore
				{
					type: "rules",
					context: "bad-rules",
					title: "t",
					content: "c",
					scope: "project",
				},
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].context).toBe("ok");
	});

	it("handles whitespace around JSON", () => {
		const json = `\n\n  {"memories": []}  \n`;
		expect(parseExtractionResult(json)).toEqual([]);
	});
});

describe("splitObservations", () => {
	it("divides content into individual observations, ignoring header", () => {
		const content = [
			"# Session abc — 2025-01-15",
			"",
			"## Obs #1 (10:00:00)",
			'User: "hi"',
			"Tools: (none)",
			'Agent: "hello"',
			"",
			"## Obs #2 (10:01:00)",
			'User: "how"',
			"Tools: read",
			'Agent: "ok"',
			"",
		].join("\n");
		const obs = splitObservations(content);
		expect(obs).toHaveLength(2);
		expect(obs[0]).toContain('User: "hi"');
		expect(obs[0]).not.toContain("# Session");
		expect(obs[1]).toContain('User: "how"');
	});

	it("returns empty array when no observations", () => {
		expect(splitObservations("# Session abc — 2025-01-15\n")).toEqual([]);
	});

	it("handles empty content", () => {
		expect(splitObservations("")).toEqual([]);
	});
});

describe("selectObservationsBatch", () => {
	it("selects all when within budget", () => {
		const obs = ['## Obs #1 (10:00:00)\nUser: "a"\n', '## Obs #2 (10:01:00)\nUser: "b"\n'];
		const { batch, remaining } = selectObservationsBatch(obs, 1000);
		expect(batch).toHaveLength(2);
		expect(remaining).toHaveLength(0);
	});

	it("selects prefix that fits the budget", () => {
		const obs = ["x".repeat(4000), "y".repeat(4000), "z".repeat(4000)]; // ~1000 tok cada
		const { batch, remaining } = selectObservationsBatch(obs, 2500); // cabe ~2
		expect(batch).toHaveLength(2);
		expect(remaining).toHaveLength(1);
		expect(batch[0]).toBe(obs[0]);
		expect(batch[1]).toBe(obs[1]);
		expect(remaining[0]).toBe(obs[2]);
	});

	it("guarantees at least one observation even if it overflows the budget", () => {
		const obs = ["a".repeat(100000)]; // estoura qualquer budget
		const { batch, remaining } = selectObservationsBatch(obs, 10);
		expect(batch).toHaveLength(1);
		expect(remaining).toHaveLength(0);
	});

	it("returns empty for empty input", () => {
		const { batch, remaining } = selectObservationsBatch([]);
		expect(batch).toHaveLength(0);
		expect(remaining).toHaveLength(0);
	});
});

describe("removeProcessedObservations", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-rmproc-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("removes processed observations, keeping header and remaining", () => {
		const fp = join(tmpDir, "session.md");
		writeFileSync(
			fp,
			[
				"# Session abc — 2025-01-15",
				"",
				"## Obs #1 (10:00:00)",
				'User: "a"',
				"Tools: (none)",
				'Agent: "a1"',
				"",
				"## Obs #2 (10:01:00)",
				'User: "b"',
				"Tools: (none)",
				'Agent: "b1"',
				"",
				"## Obs #3 (10:02:00)",
				'User: "c"',
				"Tools: (none)",
				'Agent: "c1"',
				"",
			].join("\n"),
		);

		removeProcessedObservations(fp, 2);

		const updated = readFileSync(fp, "utf-8");
		expect(updated).toContain("# Session abc — 2025-01-15");
		expect(updated).not.toContain('User: "a"');
		expect(updated).not.toContain('User: "b"');
		expect(updated).toContain('User: "c"');
		expect(countObservations(fp)).toBe(1);
	});

	it("handles processed >= observations (keeps header only)", () => {
		const fp = join(tmpDir, "session2.md");
		writeFileSync(fp, "# Session abc — 2025-01-15\n\n## Obs #1 (10:00:00)\nUser: \"a\"\n");
		removeProcessedObservations(fp, 10);
		expect(countObservations(fp)).toBe(0);
		expect(readFileSync(fp, "utf-8")).toContain("# Session");
	});

	it("no-op when file has no observations", () => {
		const fp = join(tmpDir, "session3.md");
		writeFileSync(fp, "# Session abc — 2025-01-15\n");
		removeProcessedObservations(fp, 5);
		expect(readFileSync(fp, "utf-8")).toBe("# Session abc — 2025-01-15\n");
	});
});

// ── Persisted summary (#4) ─────────────────────────────────────────────────

describe("parseExtractionResult summary", () => {
	it("accepts summary string", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "c",
					title: "t",
					content: "x",
					scope: "project",
					summary: "resumo",
				},
			],
		});
		const result = parseExtractionResult(json);
		expect(result).toHaveLength(1);
		expect(result[0].summary).toBe("resumo");
	});

	it("rejects non-string summary", () => {
		const json = JSON.stringify({
			memories: [
				{
					type: "gotchas",
					context: "c",
					title: "t",
					content: "x",
					scope: "project",
					summary: 42,
				},
			],
		});
		expect(parseExtractionResult(json)).toEqual([]);
	});
});

