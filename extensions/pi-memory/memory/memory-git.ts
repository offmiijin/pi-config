/**
 * pi-memory — versionamento Git do repositório de memórias.
 *
 * O Git das memórias é um repositório aninhado em MEMORIES_ROOT/.git. O
 * Markdown continua sendo a fonte canônica; este módulo apenas registra as
 * mutações já persistidas, sem misturar o índice FTS com o índice do Git.
 */

import { execFileSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { MEMORIES_ROOT } from "../constants.ts";

export const MEMORY_GITIGNORE = `# Bancos derivados do pi-memory
.pipeline.sqlite*
.index.sqlite*
.retention.sqlite*
*.sqlite-shm
*.sqlite-wal

# Temporários de escrita atômica
*.tmp
`;

type GitRunner = (args: string[], cwd: string) => string;

function defaultGitRunner(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15_000,
	});
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function normalizeRepoPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function sanitizeSubjectPart(value: string, fallback: string): string {
	const cleaned = value
		.replace(/[\r\n]+/g, " ")
		.replace(/[^\p{L}\p{N}._/-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.trim();
	return cleaned || fallback;
}

/** Convenção única para commits automáticos de memória. */
export function formatMemoryCommitMessage(params: {
	projectId: string;
	scope: "global" | "project";
	type: string;
	action: "cria" | "atualiza" | "substitui" | "reduz" | "migra" | "recupera";
	context: string;
}): string {
	const owner =
		params.scope === "global"
			? "global"
			: sanitizeSubjectPart(params.projectId, "projeto");
	const scopePath = params.scope === "global" ? "_global" : "projects";
	const type = sanitizeSubjectPart(params.type, "memoria");
	const context = sanitizeSubjectPart(params.context, "contexto");
	return `[${owner}] mem(${scopePath}/${type}): ${params.action} ${context}`;
}

export interface MemoryGitResult {
	ok: boolean;
	action: "initialized" | "committed" | "noop" | "pending" | "degraded";
	commit?: string;
	error?: string;
}

type PendingMutation = {
	paths: string[];
	message: string;
};

/** Repositório Git aninhado responsável somente pelo conteúdo de memories/. */
export class MemoryGitRepository {
	readonly root: string;
	private readonly runGit: GitRunner;
	private readonly lockPath: string;
	private readonly pendingPath: string;

	constructor(root: string = MEMORIES_ROOT, runGit: GitRunner = defaultGitRunner) {
		this.root = resolve(root);
		this.runGit = runGit;
		this.lockPath = join(this.root, ".git", "pi-memory.lock");
		this.pendingPath = join(this.root, ".git", "pi-memory-pending.json");
	}

	get gitPath(): string {
		return join(this.root, ".git");
	}

	/**
	 * Inicializa o repositório de forma idempotente e cria a política local de
	 * ignore. Quando já existem memórias, o primeiro commit serve de baseline.
	 */
	initialize(): MemoryGitResult {
		try {
			mkdirSync(this.root, { recursive: true });
			const wasInitialized = existsSync(this.gitPath);
			if (!wasInitialized) {
				this.runGit(["init", "--quiet", "--initial-branch=main"], this.root);
			}
			if (!existsSync(this.gitPath)) {
				return { ok: false, action: "degraded", error: "git init não criou memories/.git" };
			}

			const gitignorePath = join(this.root, ".gitignore");
			let gitignoreCreated = false;
			if (!existsSync(gitignorePath)) {
				this.writeAtomic(gitignorePath, MEMORY_GITIGNORE);
				gitignoreCreated = true;
			}

			if (!wasInitialized) {
				const baseline = this.commit(["."], "[memórias] mem(repo): cria baseline do repositório");
				if (baseline.ok) return { ...baseline, action: "initialized" };
				this.enqueuePending(["."], "[memórias] mem(repo): cria baseline do repositório");
				return { ok: false, action: "pending", error: baseline.error };
			}

			if (gitignoreCreated) {
				return this.commit([".gitignore"], "[memórias] mem(repo): registra política de arquivos");
			}

			return this.recoverPending();
		} catch (error) {
			return { ok: false, action: "degraded", error: errorMessage(error) };
		}
	}

	/** Retorna o estado atual do repositório para manutenção manual. */
	status(): string {
		return this.runGit(["status", "--short"], this.root);
	}

	/** Retorna commits recentes, limitados para não inundar o contexto do agente. */
	log(limit = 20): string {
		const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
		return this.runGit(["log", "--oneline", "--decorate", "-n", String(safeLimit)], this.root);
	}

	/** Compara o working tree ou uma revisão com um path opcional. */
	diff(path?: string, ref?: string): string {
		const args = ["diff"];
		if (ref) args.push(ref);
		args.push("--");
		if (path) args.push(this.toRepoPath(path));
		return this.runGit(args, this.root);
	}

	/** Lê o conteúdo de um path em uma revisão específica. */
	show(ref: string, path: string): string {
		return this.runGit(["show", `${ref}:${this.toRepoPath(path)}`], this.root);
	}

	/** Busca texto no snapshot atual ou em uma revisão. */
	grep(query: string, ref?: string): string {
		const args = ["grep", "-n", "-e", query];
		if (ref) args.push(ref);
		args.push("--");
		try {
			return this.runGit(args, this.root);
		} catch (error) {
			// git grep usa exit code 1 quando não há correspondências.
			if ((error as { status?: unknown }).status === 1) return "";
			throw error;
		}
	}

	/** Tenta concluir mutações que ficaram pendentes por falha do Git. */
	recoverPending(): MemoryGitResult {
		const pending = this.readPending();
		if (pending.length === 0) return { ok: true, action: "noop" };

		const remaining: PendingMutation[] = [];
		let last: MemoryGitResult = { ok: true, action: "noop" };
		for (const mutation of pending) {
			last = this.commit(mutation.paths, mutation.message, false);
			if (!last.ok) {
				remaining.push(mutation);
				remaining.push(...pending.slice(pending.indexOf(mutation) + 1));
				break;
			}
		}
		this.writePending(remaining);
		return remaining.length > 0
			? { ok: false, action: "pending", error: last.error }
			: last;
	}

	/**
	 * Faz stage e commit somente dos paths da operação. Falha deixa a mutação
	 * registrada para retry posterior, sem desfazer o Markdown canônico.
	 */
	commit(paths: string[], message: string, enqueueOnFailure = true): MemoryGitResult {
		if (!existsSync(this.gitPath)) {
			return { ok: false, action: "degraded", error: "memories/.git não está inicializado" };
		}
		if (paths.length === 0) return { ok: true, action: "noop" };

		const repoPaths = paths.map((path) => this.toRepoPath(path));
		try {
			return this.withLock(() => {
			try {
				const stagedBefore = this.stagedPaths();
				if (stagedBefore.length > 0) {
					return {
						ok: false,
						action: "degraded",
						error: "há alterações já staged no repositório de memórias",
					};
				}

				this.runGit(["add", "-A", "--", ...repoPaths], this.root);
				const stagedAfter = this.stagedPaths();
				if (stagedAfter.length === 0) return { ok: true, action: "noop" };

				const allowed = repoPaths.includes(".")
					? () => true
					: (path: string) => repoPaths.includes(path);
				const unexpected = stagedAfter.filter((path) => !allowed(path));
				if (unexpected.length > 0) {
					this.runGit(["reset", "--quiet", "--", ...stagedAfter], this.root);
					return {
						ok: false,
						action: "degraded",
						error: `stage incluiu paths inesperados: ${unexpected.join(", ")}`,
					};
				}

				this.runGit(["commit", "--quiet", "-m", message], this.root);
				const commit = this.runGit(["rev-parse", "HEAD"], this.root).trim();
				return { ok: true, action: "committed", commit };
			} catch (error) {
				const failure = { ok: false, action: "pending" as const, error: errorMessage(error) };
				try {
					this.runGit(["reset", "--quiet", "--", ...repoPaths], this.root);
				} catch {
					// O estado staged fica visível para manutenção manual.
				}
				if (enqueueOnFailure) this.enqueuePending(repoPaths, message);
				return failure;
			}
		});
		} catch (error) {
			if (enqueueOnFailure) this.enqueuePending(repoPaths, message);
			return { ok: false, action: "pending", error: errorMessage(error) };
		}
	}

	private stagedPaths(): string[] {
		const output = this.runGit(["diff", "--cached", "--name-only"], this.root);
		return output
			.split("\n")
			.map((path) => normalizeRepoPath(path.trim()))
			.filter(Boolean);
	}

	private toRepoPath(path: string): string {
		const absolute = resolve(this.root, path);
		const rel = normalizeRepoPath(relative(this.root, absolute));
		if (rel === "" || rel === ".") return ".";
		if (rel === ".." || rel.startsWith("../")) {
			throw new Error(`path fora do repositório de memórias: ${path}`);
		}
		return rel;
	}

	private withLock<T>(fn: () => T): T {
		let fd: number | undefined;
		try {
			fd = openSync(this.lockPath, "wx", 0o600);
			return fn();
		} finally {
			if (fd !== undefined) {
				closeSync(fd);
				try {
					unlinkSync(this.lockPath);
				} catch {
					// lock já removido ou processo sem permissão de limpeza
				}
			}
		}
	}

	private readPending(): PendingMutation[] {
		try {
			if (!existsSync(this.pendingPath)) return [];
			const parsed = JSON.parse(readFileSync(this.pendingPath, "utf-8")) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((item): item is PendingMutation => {
				if (!item || typeof item !== "object") return false;
				const candidate = item as Record<string, unknown>;
				return (
					Array.isArray(candidate.paths) &&
					candidate.paths.every((path) => typeof path === "string") &&
					typeof candidate.message === "string"
				);
			});
		} catch {
			return [];
		}
	}

	private enqueuePending(paths: string[], message: string): void {
		const current = this.readPending();
		const next = [...current, { paths, message }];
		this.writePending(next);
	}

	private writePending(pending: PendingMutation[]): void {
		if (pending.length === 0) {
			rmSync(this.pendingPath, { force: true });
			return;
		}
		this.writeAtomic(this.pendingPath, `${JSON.stringify(pending, null, 2)}\n`);
	}

	private writeAtomic(path: string, content: string): void {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		try {
			writeFileSync(tmp, content, { mode: 0o600 });
			renameSync(tmp, path);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
	}
}
