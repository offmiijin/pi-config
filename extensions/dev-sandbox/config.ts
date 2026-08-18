/**
 * Carregamento e merge de configuração do dev-sandbox.
 *
 * Ordem de precedência (último sobrescreve):
 *   1. DEFAULT_CONFIG (types.ts)
 *   2. ~/.pi/agent/extensions/dev-sandbox.json (global)
 *   3. .pi/sandbox.json (projeto)
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getAgentDir, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig, SandboxWorkspaceMode } from "./types";
import { DEFAULT_CONFIG, PROFILE_NAMES } from "./types";

// ── Detecção de SO ────────────────────────────────────────────────────

const OS_RELEASE_PATH = "/etc/os-release";

interface OsRelease {
	id: string;
	idLike: string;
}

/**
 * Lê /etc/os-release (mockável em testes via node:fs).
 * Exportado para testes.
 */
export function readOsRelease(): OsRelease | null {
	try {
		const raw = readFileSync(OS_RELEASE_PATH, "utf-8");
		const id = raw.match(/^ID="?([^^"\n]+)"?/m)?.[1] ?? "";
		const idLike = raw.match(/^ID_LIKE="?([^^"\n]+)"?/m)?.[1] ?? "";
		return { id: id.toLowerCase(), idLike: idLike.toLowerCase() };
	} catch {
		return null;
	}
}

function hasOsRelease(): boolean {
	return existsSync(OS_RELEASE_PATH);
}

/**
 * Parse de /etc/os-release: retorna id e idLike. Exportado para testes.
 */
export function matchesOsRelease(ids: string[]): boolean {
	const os = readOsRelease();
	if (!os) return false;
	return ids.includes(os.id) || os.idLike.split(/\s+/).some((like) => ids.includes(like));
}

/** JSON inválido → null. Exportado para testes. */
export function safeReadJson(filePath: string): Partial<SandboxConfig> | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Merge aninhado. Exportado para testes. */
export function deepMerge<T extends object>(base: T, override: object): T {
  const result = { ...base } as unknown as Record<string, unknown>;

  for (const key of Object.keys(override)) {
    const baseVal = (base as unknown as Record<string, unknown>)[key];
    const overrideVal = (override as unknown as Record<string, unknown>)[key];

    if (
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal) &&
      typeof overrideVal === "object" &&
      overrideVal !== null &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(baseVal, overrideVal);
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }

  return result as unknown as T;
}

/**
 * Converte formato antigo (mountReadOnly) para o novo (mode).
 * Retorna o objeto original se já estiver no formato novo.
 * Exportado para testes.
 */
export function normalizeSshConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as { mountReadOnly?: unknown; mode?: unknown };
  if (obj.mountReadOnly !== undefined && obj.mode === undefined) {
    const copy = { ...obj };
    copy.mode = obj.mountReadOnly === true ? "mount" : "none";
    delete copy.mountReadOnly;
    return copy;
  }
  return raw;
}

/**
 * Normaliza a escrita do modo de workspace de um perfil.
 * Aceita formas verbosas (legado/usuário): "read-write"/"writable" → "rw",
 * "readonly"/"read-only" → "ro". Valores canônicos passam intactos.
 * Valor inválido → undefined (sanitização volta ao default).
 */
export function normalizeWorkspaceMode(v: unknown): SandboxWorkspaceMode | undefined {
  if (v === "rw" || v === "ro" || v === "none") return v;
  if (v === "read-write" || v === "writable") return "rw";
  if (v === "readonly" || v === "read-only") return "ro";
  return undefined;
}

/** Opções de carregamento da configuração. */
export interface LoadConfigOptions {
  /**
   * Se false, o `.pi/sandbox.json` do projeto é ignorado
   * (projeto não confiável). A config global continua valendo.
   */
  projectTrusted?: boolean;
}

/**
 * Valida a configuração final: campos com tipo errado (JSON inválido)
 * são resetados para o default. Configuração corrompida não pode
 * quebrar o sandbox em runtime nem enfraquecer o isolamento.
 */
export function sanitizeConfig(raw: SandboxConfig): SandboxConfig {
  const out = structuredClone(DEFAULT_CONFIG);

  if (raw.worktree && typeof raw.worktree === "object") {
    const wt = raw.worktree as unknown as Record<string, unknown>;
    if (typeof wt.enabled === "boolean") out.worktree.enabled = wt.enabled;
    if (typeof wt.root === "string" && wt.root.trim() !== "") out.worktree.root = wt.root;
    if (wt.cleanup === "always" || wt.cleanup === "never") out.worktree.cleanup = wt.cleanup;
  }

  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;

  if (raw.internet && typeof raw.internet.enabled === "boolean") {
    out.internet.enabled = raw.internet.enabled;
  }

  const fs = raw.filesystem;
  if (fs && typeof fs === "object") {
    if (Array.isArray(fs.extraWritable)) {
      out.filesystem.extraWritable = fs.extraWritable.filter((s): s is string => typeof s === "string");
    }
    if (Array.isArray(fs.extraReadonly)) {
      out.filesystem.extraReadonly = fs.extraReadonly.filter((s): s is string => typeof s === "string");
    }
    if (Array.isArray(fs.denyPaths)) {
      out.filesystem.denyPaths = fs.denyPaths.filter((s): s is string => typeof s === "string");
    }
    if (Array.isArray(fs.denyFilePatterns)) {
      out.filesystem.denyFilePatterns = fs.denyFilePatterns.filter((s): s is string => typeof s === "string");
    }
    if (fs.cacheDirs && typeof fs.cacheDirs === "object") {
      const cd = fs.cacheDirs as unknown as Record<string, unknown>;
      for (const k of ["npm", "pip", "clones"] as const) {
        if (typeof cd[k] === "string") out.filesystem.cacheDirs[k] = cd[k];
      }
    }
    if (fs.quarantineDirs && typeof fs.quarantineDirs === "object") {
      const qd = fs.quarantineDirs as unknown as Record<string, unknown>;
      for (const k of ["fetch", "runs"] as const) {
        if (typeof qd[k] === "string") out.filesystem.quarantineDirs[k] = qd[k];
      }
    }
  }

  if (raw.ssh && (raw.ssh.mode === "agent" || raw.ssh.mode === "mount" || raw.ssh.mode === "none")) {
    out.ssh.mode = raw.ssh.mode;
  }

  if (raw.capabilities && typeof raw.capabilities === "object" && Array.isArray(raw.capabilities.drop)) {
    out.capabilities.drop = raw.capabilities.drop.filter((s): s is string => typeof s === "string");
  }

  if (raw.seccomp && typeof raw.seccomp === "object") {
    if (typeof raw.seccomp.enabled === "boolean") out.seccomp.enabled = raw.seccomp.enabled;
    if (typeof raw.seccomp.bpfPath === "string") out.seccomp.bpfPath = raw.seccomp.bpfPath;
  }

  if (raw.landlock && typeof raw.landlock === "object") {
    const l = raw.landlock as unknown as Record<string, unknown>;
    if (typeof l.enabled === "boolean") out.landlock.enabled = l.enabled;
    if (typeof l.required === "boolean") out.landlock.required = l.required;
    if (typeof l.minAbi === "number" && Number.isInteger(l.minAbi) && l.minAbi >= 1 && l.minAbi <= 5) {
      out.landlock.minAbi = l.minAbi;
    }
  }

  // Perfis de isolamento
  if (raw.profiles && typeof raw.profiles === "object") {
    const rp = raw.profiles as Record<string, unknown>;
    for (const name of PROFILE_NAMES) {
      const p = rp[name];
      if (!p || typeof p !== "object") continue;
      const prof = p as Record<string, unknown>;
      const target = out.profiles[name];
      if (typeof prof.enabled === "boolean") target.enabled = prof.enabled;
      // Perfis de quarentena nunca recebem workspace, SSH ou rede implícitos.
      if (name === "normal") {
        const ws = normalizeWorkspaceMode(prof.workspace);
        if (ws !== undefined) target.workspace = ws;
        if (typeof prof.network === "boolean") target.network = prof.network;
        if (prof.ssh === "agent" || prof.ssh === "mount" || prof.ssh === "none") {
          target.ssh = prof.ssh;
        }
      } else {
        target.workspace = "none";
        target.ssh = "none";
        if (name === "fetch" && typeof prof.network === "boolean") {
          target.network = prof.network;
        }
        if (name === "quarantine") target.network = false;
      }
    }
  }

  return out;
}

/**
 * Carrega configuração completa com merge de defaults, global e projeto.
 *
 * Retorna um clone do DEFAULT_CONFIG: mutações feitas pelo chamador
 * nunca contaminam o objeto padrão global. JSON com tipos inválidos
 * é saneado (campos inválidos voltam ao default).
 */
export function loadConfig(cwd: string, options: LoadConfigOptions = {}): SandboxConfig {
  // Global
  const agentDir = getAgentDir();
  const globalPath = join(agentDir, "extensions", "dev-sandbox.json");

  // Projeto
  const projectPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");

  let config = structuredClone(DEFAULT_CONFIG);

  const globalOverlay = safeReadJson(globalPath);
  if (globalOverlay) {
    // Normaliza formato antigo → novo antes do merge
    if (globalOverlay.ssh) {
      (globalOverlay as { ssh?: unknown }).ssh = normalizeSshConfig(globalOverlay.ssh);
    }
    config = deepMerge(config, globalOverlay);
  }

  // Config do projeto só entra para projetos confiáveis
  if (options.projectTrusted !== false) {
    const projectOverlay = safeReadJson(projectPath);
    if (projectOverlay) {
      // Normaliza formato antigo → novo antes do merge
      if (projectOverlay.ssh) {
        (projectOverlay as { ssh?: unknown }).ssh = normalizeSshConfig(projectOverlay.ssh);
      }
      config = deepMerge(config, projectOverlay);
    }
  }

  return sanitizeConfig(config);
}

/**
 * Verifica se bubblewrap está instalado e acessível.
 */
export function isBwrapAvailable(): boolean {
	const paths = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];
	for (const p of paths) {
		if (existsSync(p)) return true;
	}
	// Tenta via PATH (import ESM — sem require())
	try {
		execFileSync("bwrap", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Retorna comando de instalação do bubblewrap específico para o SO do usuário.
 */
export function getBwrapInstallGuide(): string {
	const platform = process.platform;

	if (platform === "darwin") {
		return "`brew install bubblewrap`";
	}

	if (platform === "win32") {
		return "bubblewrap não suporta Windows nativamente. Use WSL2 com Linux.";
	}

	if (platform === "linux") {
		if (!hasOsRelease()) {
			return "https://github.com/containers/bubblewrap#installing";
		}

		if (matchesOsRelease(["arch", "manjaro", "endeavouros"])) {
			return "`pacman -S bubblewrap`";
		}
		if (matchesOsRelease(["ubuntu", "debian", "pop", "zorin", "mint"])) {
			return "`apt install bubblewrap`";
		}
		if (matchesOsRelease(["fedora"])) {
			return "`dnf install bubblewrap`";
		}
		if (matchesOsRelease(["rhel", "centos"])) {
			return "`yum install bubblewrap`";
		}
		if (matchesOsRelease(["suse", "opensuse"])) {
			return "`zypper install bubblewrap`";
		}
		if (matchesOsRelease(["alpine"])) {
			return "`apk add bubblewrap`";
		}

		return "https://github.com/containers/bubblewrap#installing";
	}

	return "https://github.com/containers/bubblewrap#installing";
}

/**
 * Retorna comando de instalação do ripgrep específico para o SO do usuário.
 */
export function getRgInstallGuide(): string {
	const platform = process.platform;

	if (platform === "darwin") {
		return "`brew install ripgrep`";
	}

	if (platform === "win32") {
		return "`winget install BurntSushi.ripgrep.MSVC`";
	}

	if (platform === "linux") {
		if (!hasOsRelease()) {
			return "https://github.com/BurntSushi/ripgrep#installation";
		}

		if (matchesOsRelease(["arch", "manjaro", "endeavouros"])) {
			return "`pacman -S ripgrep`";
		}
		if (matchesOsRelease(["ubuntu", "debian", "pop", "zorin", "mint"])) {
			return "`apt install ripgrep`";
		}
		if (matchesOsRelease(["fedora"])) {
			return "`dnf install ripgrep`";
		}
		if (matchesOsRelease(["rhel", "centos"])) {
			return "`yum install ripgrep` (EPEL) ou `dnf install ripgrep` (RHEL 8+)";
		}
		if (matchesOsRelease(["suse", "opensuse"])) {
			return "`zypper install ripgrep`";
		}
		if (matchesOsRelease(["alpine"])) {
			return "`apk add ripgrep`";
		}

		return "https://github.com/BurntSushi/ripgrep#installation";
	}

	return "https://github.com/BurntSushi/ripgrep#installation";
}

/**
 * Verifica se ripgrep está instalado e acessível.
 */
export function isRgAvailable(): boolean {
	try {
		execFileSync("rg", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
