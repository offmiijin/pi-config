import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry, MemoryQuery, MemorySnapshot } from "./types.ts";

export const MEMORY_TYPES = ["_rules", "decisions", "gotchas", "lessons", "patterns"] as const;

export function getMemoriesRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "memories");
}

function normalizeRemote(remote: string): string {
	return remote
		.replace(/^git@/, "")
		.replace(/^https?:\/\//, "")
		.replace(/^ssh:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "")
		.replace(/[/:]/g, "_");
}

/** Mesma regra do pi-memory: remote normalizado ou `__unmanaged_<hash>`. */
export function identifyProjectId(cwd: string): string {
	try {
		const remote = execSync("git remote get-url origin", {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 3000,
		}).trim();
		if (remote) return normalizeRemote(remote);
	} catch {
		// Sem git — cai no fallback por hash do cwd.
	}
	return `__unmanaged_${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`;
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
	if (!content.startsWith("---")) return { meta: {}, body: content };
	const end = content.indexOf("\n---", 3);
	if (end < 0) return { meta: {}, body: content };
	const raw = content.slice(3, end).trim();
	const body = content.slice(end + 4).replace(/^\r?\n/, "");
	const meta: Record<string, unknown> = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (!match) continue;
		const key = match[1] ?? "";
		if (!key) continue;
		const rawValue = (match[2] ?? "").trim();
		let value: unknown = rawValue;
		if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
			value = rawValue.slice(1, -1);
		} else if (rawValue === "true") value = true;
		else if (rawValue === "false") value = false;
		else if (rawValue !== "" && Number.isFinite(Number(rawValue))) value = Number(rawValue);
		meta[key] = value;
	}
	return { meta, body };
}

function extractTitle(body: string): string | undefined {
	const snapshot = body.match(/^#\s+(.+)$/m);
	if (snapshot) return snapshot[1].trim();
	const matches = [...body.matchAll(/^## \[[^\]]+\]\s+(.+)$/gm)];
	if (matches.length > 0) return matches[matches.length - 1]?.[1]?.trim();
	return undefined;
}

function extractExcerpt(body: string, maxChars = 150): string {
	const clean = body
		.replace(/^#\s+.*$/m, "")
		.replace(/^## \[[^\]]+\][^\n]*\n/g, "")
		.replace(/^confidence:.*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(-maxChars).trimStart()}…`;
}

function readEntryFile(filePath: string, relPath: string, scope: MemoryEntry["scope"], type: string, context: string): MemoryEntry | null {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const { meta, body } = parseFrontmatter(content);
	return {
		scope,
		type,
		context,
		title: extractTitle(body) ?? context,
		...(typeof meta.summary === "string" ? { summary: meta.summary } : {}),
		excerpt: extractExcerpt(body),
		confidence: typeof meta.confidence === "number" ? meta.confidence : 0.5,
		updated: typeof meta.updated === "string" ? meta.updated : "",
		path: relPath,
	};
}

function listDirEntries(root: string, scope: MemoryEntry["scope"], projectId: string): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	for (const type of MEMORY_TYPES) {
		const dir = scope === "global" ? join(root, "_global", type) : join(root, "projects", projectId, type);
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
		} catch {
			continue;
		}
		for (const file of files) {
			const context = file.slice(0, -3);
			const relPath = scope === "global" ? `_global/${type}/${file}` : `projects/${projectId}/${type}/${file}`;
			const entry = readEntryFile(join(dir, file), relPath, scope, type, context);
			if (entry) entries.push(entry);
		}
	}
	return entries;
}

/** Filtro puro (testável): escopo + tipo + busca em title/summary/context/excerpt. */
export function filterEntries(entries: MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
	const search = query.search.trim().toLowerCase();
	return entries
		.filter((e) => query.scope === "all" || e.scope === query.scope)
		.filter((e) => query.type === "all" || e.type === query.type)
		.filter((e) => {
			if (!search) return true;
			return [e.title, e.summary ?? "", e.context, e.excerpt]
				.some((field) => field.toLowerCase().includes(search));
		})
		.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
}

export function listAvailableProjects(root = getMemoriesRoot()): string[] {
	try {
		return readdirSync(join(root, "projects"), { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
	} catch {
		return [];
	}
}

/** Lê o corpo do .md para o preview (limitado a maxChars). */
export function readMemoryPreview(root: string, relPath: string, maxChars = 4000): string {
	try {
		const content = readFileSync(join(root, relPath), "utf-8");
		return content.length > maxChars ? `${content.slice(0, maxChars)}…` : content;
	} catch {
		return "Não foi possível ler o arquivo de memória.";
	}
}

export class MemoryStore {
	private readonly memoriesRoot: string;
	private cacheMtimeMs = 0;
	private cacheEntries: MemoryEntry[] = [];
	private cacheProjectId = "";

	constructor(memoriesRoot = getMemoriesRoot()) {
		this.memoriesRoot = memoriesRoot;
	}

	private loadAll(projectId: string): MemoryEntry[] {
		let newestMtime = 0;
		const touch = (dir: string): void => {
			try {
				for (const f of readdirSync(dir)) {
					if (!f.endsWith(".md")) continue;
					try {
						const { mtimeMs } = statSync(join(dir, f));
						if (mtimeMs > newestMtime) newestMtime = mtimeMs;
					} catch {
						// Arquivo removido durante a leitura — ignora.
					}
				}
			} catch {
				// Diretório ausente — ignora.
			}
		};
		for (const type of MEMORY_TYPES) {
			touch(join(this.memoriesRoot, "_global", type));
			touch(join(this.memoriesRoot, "projects", projectId, type));
		}
		if (newestMtime === this.cacheMtimeMs && projectId === this.cacheProjectId && this.cacheEntries.length > 0) {
			return this.cacheEntries;
		}
		const entries = [
			...listDirEntries(this.memoriesRoot, "global", projectId),
			...listDirEntries(this.memoriesRoot, "project", projectId),
		];
		this.cacheMtimeMs = newestMtime;
		this.cacheProjectId = projectId;
		this.cacheEntries = entries;
		return entries;
	}

	snapshot(projectId: string, query: MemoryQuery): MemorySnapshot {
		const all = this.loadAll(projectId);
		const entries = filterEntries(all, query);
		return {
			generatedAt: Date.now(),
			projectId,
			availableProjects: existsSync(this.memoriesRoot) ? listAvailableProjects(this.memoriesRoot) : [],
			query: { ...query },
			entries,
			totals: {
				global: all.filter((e) => e.scope === "global").length,
				project: all.filter((e) => e.scope === "project").length,
			},
		};
	}

	get root(): string {
		return this.memoriesRoot;
	}

	clearCache(): void {
		this.cacheMtimeMs = 0;
		this.cacheEntries = [];
		this.cacheProjectId = "";
	}
}
