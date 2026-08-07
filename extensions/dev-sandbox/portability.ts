/**
 * Portabilidade do sandbox — detecção de paths por distro, arquitetura e
 * seleção de artefatos (landlock-exec, seccomp.bpf) por arquitetura.
 *
 * Objetivo: nenhum path fixo de distribuição Linux. Tudo que é opcional
 * é condicional (existsSync). Suporte a Debian/Ubuntu (ld.so.cache,
 * multiarch /lib/*-linux-gnu via /lib), Fedora/RHEL (/lib64), Arch
 * (merged-usr, /usr/sbin symlink), NixOS (/nix, /etc/static).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ── Paths de sistema por distro ──────────────────────────────────────────

export interface SystemPaths {
	/** Diretórios read-only a montar (--ro-bind). */
	roDirs: string[];
	/** Arquivos/dirs de /etc a montar read-only. */
	etcFiles: string[];
}

/** Sempre presentes em qualquer Linux. */
const BASE_RO_DIRS = ["/usr", "/bin", "/lib"];

/**
 * Condicionais por distro:
 *   /lib64            → Fedora/RHEL/openSUSE (glibc 64-bit)
 *   /lib32, /usr/lib32, /libx32, /usr/libx32 → multilib (32-bit compat)
 *   /nix              → NixOS / nix em outra distro
 *   /etc/static       → NixOS (configs geradas)
 *   /etc/ssl, /etc/ca-certificates → TLS (Debian/Ubuntu usam ca-certificates)
 */
const CONDITIONAL_RO_DIRS = [
	"/lib64",
	"/lib32",
	"/usr/lib32",
	"/libx32",
	"/usr/libx32",
	"/nix",
	"/etc/static",
	"/etc/ssl",
	"/etc/ca-certificates",
];

/** Resolução de libs e runtime. */
const BASE_ETC_FILES = [
	"/etc/resolv.conf",
	"/etc/hosts",
	"/etc/passwd",
	"/etc/group",
	"/etc/nsswitch.conf",
];

/**
 * Arquivos de /etc condicionais:
 *   ld.so.cache/conf → Debian/Ubuntu/Fedora (cache do linker — sem ele,
 *                      libs podem não resolver corretamente no sandbox)
 *   gitconfig        → config global de git do sistema
 *   localtime        → fuso horário correto
 *   hostname         → `hostname` dentro do sandbox
 */
const CONDITIONAL_ETC = [
	"/etc/ld.so.cache",
	"/etc/ld.so.conf",
	"/etc/ld.so.conf.d",
	"/etc/gitconfig",
	"/etc/localtime",
	"/etc/hostname",
];

/** Montagens de sistema com `exists` injetável (testável). */
export function computeSystemPaths(exists: (p: string) => boolean): SystemPaths {
	return {
		roDirs: [...BASE_RO_DIRS, ...CONDITIONAL_RO_DIRS.filter(exists)],
		etcFiles: [...BASE_ETC_FILES.filter(exists), ...CONDITIONAL_ETC.filter(exists)],
	};
}

/** Montagens de sistema reais (usa existsSync). */
export function resolveSystemPaths(): SystemPaths {
	return computeSystemPaths(existsSync);
}

// ── Arquitetura ──────────────────────────────────────────────────────────

/** process.arch → triplet GNU usado nos artefatos. */
const ARCH_TRIPLET: Record<string, string> = {
	x64: "x86_64",
	arm64: "aarch64",
	riscv64: "riscv64",
	ia32: "i386",
	s390x: "s390x",
	ppc64: "ppc64",
	ppc64le: "ppc64le",
	loong64: "loongarch64",
};

export function archTriplet(arch: string = process.arch): string {
	return ARCH_TRIPLET[arch] ?? arch;
}

// ── Seleção de artefatos por arquitetura ─────────────────────────────────

/**
 * Procura o helper landlock-exec da arquitetura atual.
 * Ordem: landlock-exec-<arch> (empacotado) → landlock-exec (legado) →
 * gen-seccomp/target/release/landlock-exec (build de desenvolvimento).
 */
export function resolveLandlockExecPath(
	extDir: string,
	arch: string = archTriplet(),
	exists: (p: string) => boolean = existsSync,
): string | null {
	const candidates = [
		join(extDir, `landlock-exec-${arch}`),
		join(extDir, "landlock-exec"),
		join(extDir, "gen-seccomp", "target", "release", "landlock-exec"),
	];
	return candidates.find(exists) ?? null;
}

/**
 * Seleciona o filtro seccomp: prefere o específico da arquitetura
 * (seccomp-<arch>.bpf) e cai para o universal (seccomp.bpf), gerado
 * com x86_64 + aarch64 + riscv64 num único filtro.
 */
export function resolveSeccompBpfPath(
	extDir: string,
	arch: string = archTriplet(),
	exists: (p: string) => boolean = existsSync,
): string | null {
	const archPath = join(extDir, `seccomp-${arch}.bpf`);
	if (exists(archPath)) return archPath;
	const universal = join(extDir, "seccomp.bpf");
	return exists(universal) ? universal : null;
}

// ── User namespaces (bwrap depende) ──────────────────────────────────────

/**
 * Verifica se user namespaces estão habilitados (kernel.unprivileged_userns_clone).
 * Apenas aviso: se falhar, o bwrap falha e as tools já ficam fail-closed.
 */
export function probeUserNamespaces(): boolean {
	try {
		execFileSync("unshare", ["--user", "true"], { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}
