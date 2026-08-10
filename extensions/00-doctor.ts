/**
 * Pi Doctor — diagnóstico bootável das extensões.
 *
 * POR QUE ZERO DEPENDÊNCIAS NPM:
 *   Se os pacotes npm (`typebox`, `cheerio`, `pi-tui`, ...) faltarem, os imports
 *   das outras extensões falham ANTES de session_start — elas nunca conseguem
 *   exibir instruções de instalação. Esta extensão usa apenas node:* built-ins
 *   (e um tipo estrutural local no lugar de `@earendil-works/pi-coding-agent`,
 *   que é apagado/ignorado em runtime) para garantir que carrega SEMPRE.
 *
 *   O prefixo `00-` garante que carrega primeiro (ordem alfabética).
 *
 * Verificações:
 *   - Node >= 22.19 (exigência do pi-coding-agent)
 *   - npm CLI
 *   - Pacotes npm das extensões (hoisted em <root>/node_modules)
 *   - Binários externos: bubblewrap, ripgrep (obrigatórios do sandbox),
 *     git, gh (opcionais)
 *   - Artefatos do sandbox: seccomp.bpf, landlock-exec
 *   - User namespaces e ABI Landlock do kernel
 *   - Docker / SearXNG (opcionais, pi-web-search)
 *
 * Superfícies:
 *   - session_start: notifica 1x por processo se houver pendências (erros)
 *   - /doctor: relatório completo (inclui checagem de rede do SearXNG)
 *   - doctor_check (tool): relatório para o LLM durante troubleshooting
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Tipos estruturais locais (sem import de pi-coding-agent) ─────────────

type NotifySeverity = "info" | "warning" | "error";

interface PiUi {
	notify(message: string, severity?: NotifySeverity): void;
}

interface PiContext {
	hasUI: boolean;
	ui: PiUi;
}

interface PiToolDefinition {
	name: string;
	label?: string;
	description: string;
	promptSnippet?: string;
	// Schema de parâmetros: typebox TSchema OU objeto JSON-schema simples.
	// Sem parâmetros → objeto vazio é suficiente.
	parameters?: unknown;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	}>;
}

interface Pi {
	on(
		event: string,
		handler: (event: unknown, ctx: PiContext) => void | Promise<void>,
	): void;
	registerCommand(
		name: string,
		def: {
			description: string;
			handler: (args: string, ctx: PiContext) => void | Promise<void>;
		},
	): void;
	registerTool(def: PiToolDefinition): void;
	sendMessage(msg: { customType: string; content: string; display?: boolean }): void;
}

// ── Constantes ────────────────────────────────────────────────────────────

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = resolve(EXT_DIR, "..");
const MIN_NODE = "22.19.0";

const RUNTIME_PACKAGES = [
	{ name: "@earendil-works/pi-coding-agent", usedBy: "API de todas as extensões" },
	{ name: "@earendil-works/pi-tui", usedBy: "custom-theme" },
	{ name: "typebox", usedBy: "pi-github · pi-memory · pi-web-search" },
	{ name: "cheerio", usedBy: "pi-web-search" },
] as const;

const INSTALL_HINTS: Record<string, Record<string, string>> = {
	apt: {
		bubblewrap: "sudo apt install bubblewrap",
		ripgrep: "sudo apt install ripgrep",
		gh: "sudo apt install gh",
		git: "sudo apt install git",
		node: "sudo apt install nodejs npm",
		docker: "sudo apt install docker.io",
	},
	dnf: {
		bubblewrap: "sudo dnf install bubblewrap",
		ripgrep: "sudo dnf install ripgrep",
		gh: "sudo dnf install gh",
		git: "sudo dnf install git",
		node: "sudo dnf install nodejs npm",
		docker: "sudo dnf install docker",
	},
	pacman: {
		bubblewrap: "sudo pacman -S bubblewrap",
		ripgrep: "sudo pacman -S ripgrep",
		gh: "sudo pacman -S github-cli",
		git: "sudo pacman -S git",
		node: "sudo pacman -S nodejs npm",
		docker: "sudo pacman -S docker",
	},
	zypper: {
		bubblewrap: "sudo zypper install bubblewrap",
		ripgrep: "sudo zypper install ripgrep",
		gh: "sudo zypper install gh",
		git: "sudo zypper install git",
		node: "sudo zypper install nodejs20 npm",
		docker: "sudo zypper install docker",
	},
	apk: {
		bubblewrap: "sudo apk add bubblewrap",
		ripgrep: "sudo apk add ripgrep",
		gh: "sudo apk add github-cli",
		git: "sudo apk add git",
		node: "sudo apk add nodejs npm",
		docker: "sudo apk add docker",
	},
};

// ── Tipos de resultado ────────────────────────────────────────────────────

export type CheckStatus = "ok" | "info" | "warn" | "error";

export interface DoctorCheck {
	id: string;
	label: string;
	status: CheckStatus;
	detail?: string;
	fix?: string;
}

export interface OsRelease {
	id: string;
	idLike: string[];
	name: string;
}

export interface RunChecksOptions {
	pkgRoots?: string[];
	skipNetwork?: boolean;
	pm?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Raízes node_modules onde os pacotes das extensões são resolvidos. */
export function defaultPkgRoots(): string[] {
	return [join(AGENT_ROOT, "node_modules"), join(EXT_DIR, "node_modules")];
}

export function parseOsRelease(raw: string): OsRelease {
	const get = (key: string): string => {
		const line = raw.split("\n").find((l) => l.startsWith(`${key}=`));
		if (!line) return "";
		return line.slice(key.length + 1).replace(/^"|"$/g, "").trim();
	};
	return {
		id: get("ID").toLowerCase(),
		idLike: get("ID_LIKE").split(/\s+/).filter(Boolean),
		name: get("NAME"),
	};
}

export function readOsRelease(): OsRelease {
	try {
		return parseOsRelease(readFileSync("/etc/os-release", "utf8"));
	} catch {
		return { id: "", idLike: [], name: "" };
	}
}

/** Detecta gerenciador de pacotes a partir do /etc/os-release. */
export function detectPackageManager(os?: OsRelease): string | null {
	const rel = os ?? readOsRelease();
	const ids = [rel.id, ...rel.idLike];
	if (ids.includes("debian") || ids.includes("ubuntu")) return "apt";
	if (ids.some((i) => ["arch", "manjaro", "endeavouros", "cachyos"].includes(i))) return "pacman";
	if (ids.some((i) => ["fedora", "rhel", "centos", "rocky", "almalinux"].includes(i))) return "dnf";
	if (ids.some((i) => i.startsWith("opensuse") || i === "suse")) return "zypper";
	if (ids.includes("alpine")) return "apk";
	return null;
}

/** Comando de instalação para uma ferramenta, no gerenciador detectado. */
export function installHint(pm: string | null, tool: keyof typeof INSTALL_HINTS[string]): string {
	if (pm && INSTALL_HINTS[pm]?.[tool]) return INSTALL_HINTS[pm][tool]!;
	return `Instale "${tool}" (consulte a documentação da sua distro)`;
}

/** Localiza um pacote em uma lista de raízes node_modules; retorna dir ou null. */
export function resolvePackage(pkgRoots: string[], name: string): string | null {
	for (const root of pkgRoots) {
		const dir = join(root, name);
		if (existsSync(join(dir, "package.json"))) return dir;
	}
	return null;
}

function readPkgVersion(dir: string): string {
	try {
		return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version ?? "?";
	} catch {
		return "?";
	}
}

interface BinResult {
	ok: boolean;
	missing?: boolean;
	version?: string;
}

function runBin(cmd: string, args: string[]): BinResult {
	try {
		const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
		if (r.status === 0) {
			const first = (r.stdout ?? "").split("\n")[0]?.trim() ?? "";
			return { ok: true, version: first };
		}
		return { ok: false, missing: r.error?.code === "ENOENT" };
	} catch {
		return { ok: false };
	}
}

function nodeTooOld(current: string, min: string): boolean {
	const [cM, cm, cp] = current.split(".").map(Number);
	const [mM, mm, mp] = min.split(".").map(Number);
	return cM < mM || (cM === mM && cm < mm) || (cM === mM && cm === mm && cp < mp);
}

async function searxngReachable(): Promise<boolean> {
	try {
		const res = await fetch("http://localhost:4000/search?q=pi&format=json", {
			signal: AbortSignal.timeout(3000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

// ── Checagens ─────────────────────────────────────────────────────────────

export async function runChecks(opts: RunChecksOptions = {}): Promise<DoctorCheck[]> {
	const pkgRoots = opts.pkgRoots ?? defaultPkgRoots();
	const skipNetwork = opts.skipNetwork ?? true;
	const pm = opts.pm !== undefined ? opts.pm : detectPackageManager();
	const checks: DoctorCheck[] = [];

	// Node runtime
	const nodeVersion = process.versions.node;
	checks.push({
		id: "node",
		label: "Node runtime",
		status: nodeTooOld(nodeVersion, MIN_NODE) ? "error" : "ok",
		detail: nodeVersion,
		fix: nodeTooOld(nodeVersion, MIN_NODE)
			? `pi requer Node >= ${MIN_NODE} (ex: mise install node@22)`
			: undefined,
	});

	// npm CLI
	const npm = runBin("npm", ["--version"]);
	checks.push({
		id: "npm",
		label: "npm CLI",
		status: npm.ok ? "ok" : "error",
		detail: npm.ok ? `npm ${npm.version}` : "não encontrado",
		fix: npm.ok ? undefined : installHint(pm, "node"),
	});

	// Pacotes npm das extensões
	const missingPkgs = RUNTIME_PACKAGES.filter((p) => !resolvePackage(pkgRoots, p.name));
	const foundPkgs = RUNTIME_PACKAGES.filter((p) => resolvePackage(pkgRoots, p.name));
	checks.push({
		id: "npm-packages",
		label: "Pacotes npm das extensões",
		status: missingPkgs.length === 0 ? "ok" : "error",
		detail:
			missingPkgs.length === 0
				? foundPkgs.map((p) => `${p.name}@${readPkgVersion(resolvePackage(pkgRoots, p.name)!)}`).join(" · ")
				: `ausentes: ${missingPkgs.map((p) => p.name).join(", ")}`,
		fix:
			missingPkgs.length === 0
				? undefined
				: `cd ${AGENT_ROOT} && npm ci`,
	});

	// Binários externos
	const bwrap = runBin("bwrap", ["--version"]);
	checks.push({
		id: "bwrap",
		label: "bubblewrap (sandbox)",
		status: bwrap.ok ? "ok" : "error",
		detail: bwrap.ok ? bwrap.version : "não encontrado",
		fix: bwrap.ok ? undefined : `${installHint(pm, "bubblewrap")} — sem ele o sandbox fica fail-closed (tools bloqueadas)`,
	});

	const rg = runBin("rg", ["--version"]);
	checks.push({
		id: "rg",
		label: "ripgrep (tool grep)",
		status: rg.ok ? "ok" : "warn",
		detail: rg.ok ? rg.version : "não encontrado",
		fix: rg.ok ? undefined : `${installHint(pm, "ripgrep")} — grep opera em modo degradado`,
	});

	const git = runBin("git", ["--version"]);
	checks.push({
		id: "git",
		label: "git",
		status: git.ok ? "ok" : "warn",
		detail: git.ok ? git.version : "não encontrado",
		fix: git.ok ? undefined : `${installHint(pm, "git")} — pi-memory cai para fallback __unmanaged_`,
	});

	const gh = runBin("gh", ["--version"]);
	checks.push({
		id: "gh",
		label: "gh CLI (pi-github)",
		status: gh.ok ? "ok" : "warn",
		detail: gh.ok ? gh.version : "não encontrado",
		fix: gh.ok ? undefined : `${installHint(pm, "gh")} — pi-github fica desativada (opcional)`,
	});

	// Artefatos do sandbox
	const devSandboxDir = join(EXT_DIR, "dev-sandbox");
	const seccompOk = existsSync(join(devSandboxDir, "seccomp.bpf"));
	checks.push({
		id: "seccomp-bpf",
		label: "seccomp.bpf (sandbox)",
		status: seccompOk ? "ok" : "warn",
		detail: seccompOk ? "presente" : "não encontrado",
		fix: seccompOk ? undefined : "sandbox roda sem seccomp (modo degradado); gere com gen-seccomp",
	});

	// landlock-exec: empacotado por arquitetura (landlock-exec-<arch>),
	// legado (landlock-exec) ou build de desenvolvimento (target/release).
	// Validado por EXECUÇÃO real (--probe-abi): pega binário inexecutável
	// (arch errada, glibc antiga/musl) que existsSync deixaria passar.
	const ARCH_TRIPLET_LOCK: Record<string, string> = {
		x64: "x86_64",
		arm64: "aarch64",
		riscv64: "riscv64",
	};
	const archName = ARCH_TRIPLET_LOCK[process.arch] ?? process.arch;
	const landlockCandidates = [
		join(devSandboxDir, `landlock-exec-${archName}`),
		join(devSandboxDir, "landlock-exec"),
		join(devSandboxDir, "gen-seccomp", "target", "release", "landlock-exec"),
	];
	let landlockOk = false;
	let landlockDetail = "não encontrado";
	for (const candidate of landlockCandidates) {
		if (!existsSync(candidate)) continue;
		const probe = runBin(candidate, ["--probe-abi"]);
		if (probe.ok) {
			landlockOk = true;
			landlockDetail = `presente (ABI ${probe.version ?? "?"})`;
			break;
		}
		landlockDetail = `encontrado mas inexecutável (glibc/arch incompatível?): ${candidate}`;
	}
	checks.push({
		id: "landlock-exec",
		label: "landlock-exec (sandbox)",
		status: landlockOk ? "ok" : "warn",
		detail: landlockDetail,
		fix: landlockOk
			? undefined
			: "sandbox opera sem a camada Landlock; rode gen-seccomp/build.sh para compilar (dev-sandbox/README)",
	});

	// User namespaces (bwrap depende)
	const userns = runBin("unshare", ["--user", "true"]);
	checks.push({
		id: "userns",
		label: "User namespaces (bwrap)",
		status: userns.ok ? "ok" : "warn",
		detail: userns.ok ? "disponíveis" : "indisponíveis",
		fix: userns.ok
			? undefined
			: "habilite kernel.unprivileged_userns_clone=1 (sysctl) — senão o sandbox fica fail-closed",
	});

	// ABI Landlock do kernel (informativo)
	let landlockAbi: string | null = null;
	try {
		landlockAbi = readFileSync("/proc/sys/kernel/landlock/abi", "utf8").trim();
	} catch {
		landlockAbi = null;
	}
	checks.push({
		id: "landlock-abi",
		label: "Landlock ABI (kernel)",
		status: "info",
		detail: landlockAbi ? `ABI ${landlockAbi}` : "indisponível (kernel < 5.13 ou /proc sem exposição)",
	});

	// Docker / SearXNG (opcionais)
	const dockerSocket = existsSync("/var/run/docker.sock");
	const dockerBin = runBin("docker", ["--version"]);
	checks.push({
		id: "docker",
		label: "Docker (pi-web-search)",
		status: "info",
		detail: dockerBin.ok
			? `binário presente${dockerSocket ? " · socket acessível" : " · socket não acessível" }`
			: "não encontrado",
		fix: dockerBin.ok
			? undefined
			: `${installHint(pm, "docker")} + SearXNG são opcionais — use APIs externas: /web_search config <tavily|exa|serper> <key>`,
	});

	if (!skipNetwork) {
		const searxngOk = await searxngReachable();
		checks.push({
			id: "searxng",
			label: "SearXNG local (pi-web-search)",
			status: "info",
			detail: searxngOk ? "respondendo em localhost:4000" : "não respondeu em localhost:4000",
			fix: searxngOk
				? undefined
				: "suba o container (docker compose up -d em extensions/pi-web-search) ou configure APIs externas",
		});
	}

	return checks;
}

// ── Relatório ─────────────────────────────────────────────────────────────

const STATUS_ICON: Record<CheckStatus, string> = {
	ok: "✅",
	info: "ℹ️",
	warn: "⚠️",
	error: "❌",
};

export function buildReportText(checks: DoctorCheck[], os?: OsRelease, pm?: string | null): string {
	const header = [
		"🧑⚕️ Pi Doctor — diagnóstico das extensões",
		`Sistema: ${os?.name || "desconhecido"}${pm ? ` · pacotes: ${pm}` : ""}`,
		"",
	];
	const body = checks.map((c) => {
		const line = `${STATUS_ICON[c.status]} ${c.label}: ${c.detail ?? ""}`;
		return c.fix ? `${line}\n   Fix: ${c.fix}` : line;
	});
	const counts = checks.reduce<Record<CheckStatus, number>>(
		(acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
		{ ok: 0, info: 0, warn: 0, error: 0 },
	);
	const summary = `Resumo: ${counts.ok} ok · ${counts.info} info · ${counts.warn} aviso(s) · ${counts.error} pendência(s)`;
	const footnote =
		counts.error > 0
			? `\nApós corrigir, reinicie o pi ou execute /reload.`
			: "";
	return [...header, ...body, "", summary, footnote].join("\n");
}

// ── Extensão ──────────────────────────────────────────────────────────────

export default async function (pi: Pi): Promise<void> {
	let autoNotified = false;

	const buildReport = async (withNetwork: boolean) => {
		const checks = await runChecks({
			pkgRoots: defaultPkgRoots(),
			skipNetwork: !withNetwork,
		});
		const text = buildReportText(checks, readOsRelease(), detectPackageManager());
		pi.sendMessage({ customType: "doctor_report", content: text, display: true });
		return text;
	};

	// ── Comando /doctor ─────────────────────────────
	pi.registerCommand("doctor", {
		description:
			"Diagnóstico de dependências das extensões (pacotes npm, binários, sandbox, web search). Ex: /doctor",
		handler: async () => {
			await buildReport(true);
		},
	});

	// ── Notificação automática no session_start ─────
	pi.on("session_start", async (_event, ctx) => {
		if (autoNotified) return;
		autoNotified = true;

		const checks = await runChecks({ pkgRoots: defaultPkgRoots(), skipNetwork: true });
		const errors = checks.filter((c) => c.status === "error");
		if (errors.length === 0) return; // sem pendências → silêncio (sem spam)

		const warns = checks.filter((c) => c.status === "warn");
		const text = buildReportText(checks, readOsRelease(), detectPackageManager());
		if (ctx.hasUI) {
			ctx.ui.notify(
				`🧑⚕️ Pi Doctor: ${errors.length} pendência(s) de dependências (${warns.length} aviso(s)). Rode /doctor para detalhes.`,
				"error",
			);
		}
		pi.sendMessage({ customType: "doctor_report", content: text, display: true });
	});

	// ── Tool doctor_check (para o LLM) ───────────────
	// Registrada em session_start para manter a factory síncrona e simples;
	// schema: typebox quando disponível, JSON-schema simples como fallback.
	try {
		let Type: { Object: (schema: Record<string, unknown>) => unknown } | null = null;
		try {
			Type = (await import("typebox")) as typeof Type;
		} catch {
			Type = null;
		}
		const parameters = Type ? Type.Object({}) : { type: "object", properties: {} };
		pi.registerTool({
			name: "doctor_check",
			label: "Doctor Check",
			description:
				"Roda o diagnóstico de dependências das extensões (pacotes npm, binários externos, sandbox, web search). " +
				"Use quando uma tool falhar por dependência ausente ou o ambiente parecer incompleto. " +
				"Retorna relatório com status e instruções de instalação.",
			promptSnippet: "Diagnóstico de dependências das extensões (pacotes, binários, sandbox)",
			parameters,
			async execute() {
				const checks = await runChecks({ pkgRoots: defaultPkgRoots(), skipNetwork: true });
				return {
					content: [{ type: "text", text: buildReportText(checks, readOsRelease(), detectPackageManager()) }],
					details: {},
				};
			},
		});
	} catch {
		// Tool é opcional — se o schema/registro falhar, segue sem ela.
	}
}
