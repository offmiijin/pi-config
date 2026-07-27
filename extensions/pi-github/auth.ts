/**
 * Verificação de disponibilidade e autenticação do gh CLI.
 *
 * Usa execSync do Node apenas para checagem inicial (durante carregamento
 * da extensão). Tools em runtime usam pi.exec() via gh.ts.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import type { AuthInfo } from "./types";

// ── Detecção de SO ────────────────────────────────────────────────────

const OS_RELEASE_PATH = "/etc/os-release";

interface OsRelease {
	id: string;
	idLike: string;
}

function readOsRelease(): OsRelease | null {
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

function matchesOsRelease(ids: string[]): boolean {
	const os = readOsRelease();
	if (!os) return false;
	return ids.includes(os.id) || os.idLike.split(/\s+/).some((like) => ids.includes(like));
}

/**
 * Retorna comando de instalação do gh CLI específico para o SO do usuário.
 */
export function getInstallGuide(): string {
	const platform = process.platform;

	if (platform === "darwin") {
		return "`brew install gh`";
	}

	if (platform === "win32") {
		return "`winget install GitHub.cli`";
	}

	// Linux — detecta distro
	if (platform === "linux") {
		if (!hasOsRelease()) {
			return "https://github.com/cli/cli/blob/trunk/docs/install_linux.md";
		}

		if (matchesOsRelease(["arch", "manjaro", "endeavouros"])) {
			return "`pacman -S github-cli`";
		}
		if (matchesOsRelease(["ubuntu", "debian", "pop", "zorin", "mint"])) {
			return "`apt install gh`";
		}
		if (matchesOsRelease(["fedora"])) {
			return "`dnf install gh`";
		}
		if (matchesOsRelease(["rhel", "centos"])) {
			return "`yum install gh`";
		}
		if (matchesOsRelease(["suse", "opensuse"])) {
			return "`zypper install gh`";
		}
		if (matchesOsRelease(["alpine"])) {
			return "`apk add github-cli`";
		}

		// Fallback para Linux genérico
		return "https://github.com/cli/cli/blob/trunk/docs/install_linux.md";
	}

	return "https://github.com/cli/cli#installation";
}

/**
 * Verifica se gh CLI está instalado e autenticado.
 * Chamada síncrona durante inicialização da extensão.
 */
export function getAuthInfo(): AuthInfo {
	const info: AuthInfo = {
		available: false,
		authenticated: false,
		user: "",
	};

	// gh CLI instalado?
	try {
		execSync("gh --version", { stdio: "ignore" });
		info.available = true;
	} catch {
		return info;
	}

	// Autenticado?
	try {
		const out = execSync("gh auth status 2>&1", {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		info.authenticated = true;
		const userMatch = out.match(/as\s+(\S+)/);
		if (userMatch) info.user = userMatch[1];
	} catch {
		// Não autenticado — info.authenticated já é false
	}

	return info;
}


