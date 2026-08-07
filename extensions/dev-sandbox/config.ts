/**
 * Carregamento e merge de configuração do dev-sandbox.
 *
 * Ordem de precedência (último sobrescreve):
 *   1. DEFAULT_CONFIG (types.ts)
 *   2. ~/.pi/agent/extensions/dev-sandbox.json (global)
 *   3. .pi/sandbox.json (projeto)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";

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
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base };

  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal) &&
      typeof overrideVal === "object" &&
      overrideVal !== null &&
      !Array.isArray(overrideVal)
    ) {
      (result as Record<string, unknown>)[key as string] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else if (overrideVal !== undefined) {
      (result as Record<string, unknown>)[key as string] = overrideVal;
    }
  }

  return result;
}

/**
 * Converte formato antigo (mountReadOnly) para o novo (mode).
 * Retorna uma cópia do objeto com a conversão aplicada.
 * Exportado para testes.
 */
export function normalizeSshConfig(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.mountReadOnly !== undefined && raw.mode === undefined) {
    const copy = { ...raw };
    copy.mode = raw.mountReadOnly ? "mount" : "none";
    delete copy.mountReadOnly;
    return copy;
  }
  return raw;
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
 * Carrega configuração completa com merge de defaults, global e projeto.
 *
 * Retorna um clone do DEFAULT_CONFIG: mutações feitas pelo chamador
 * nunca contaminam o objeto padrão global.
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
      (globalOverlay as Record<string, unknown>).ssh = normalizeSshConfig(
        globalOverlay.ssh as Record<string, unknown>,
      );
    }
    config = deepMerge(config, globalOverlay);
  }

  // Config do projeto só entra para projetos confiáveis
  if (options.projectTrusted !== false) {
    const projectOverlay = safeReadJson(projectPath);
    if (projectOverlay) {
      // Normaliza formato antigo → novo antes do merge
      if (projectOverlay.ssh) {
        (projectOverlay as Record<string, unknown>).ssh = normalizeSshConfig(
          projectOverlay.ssh as Record<string, unknown>,
        );
      }
      config = deepMerge(config, projectOverlay);
    }
  }

  return config;
}

/**
 * Verifica se bubblewrap está instalado e acessível.
 */
export function isBwrapAvailable(): boolean {
	const paths = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];
	for (const p of paths) {
		if (existsSync(p)) return true;
	}
	// Tenta via which
	try {
		const { execSync } = require("node:child_process");
		execSync("which bwrap 2>/dev/null || command -v bwrap 2>/dev/null", { encoding: "utf-8" });
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
		const { execSync } = require("node:child_process");
		execSync("rg --version 2>/dev/null", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
