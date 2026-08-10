/**
 * Testes de portabilidade do sandbox — paths por distro, arquitetura,
 * seleção de artefatos (landlock-exec, seccomp.bpf) e probe de userns.
 *
 * Cobre: computeSystemPaths (bases + condicionais), archTriplet,
 * resolveLandlockExecPath (ordem de candidatos), resolveSeccompBpfPath
 * (preferência por arquitetura), probeUserNamespaces (sucesso/falha).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import {
	computeSystemPaths,
	archTriplet,
	resolveLandlockExecPath,
	resolveSeccompBpfPath,
} from "../portability";

describe("computeSystemPaths", () => {
	it("sempre inclui bases de sistema (/usr, /bin, /lib)", () => {
		const paths = computeSystemPaths(() => false);
		expect(paths.roDirs).toEqual(["/usr", "/bin", "/lib"]);
	});

	it("inclui condicionais somente quando existem (ex: /lib64, /nix, /etc/ssl)", () => {
		const exists = (p: string) =>
			["/lib64", "/nix", "/etc/ssl"].includes(p);
		const paths = computeSystemPaths(exists);
		expect(paths.roDirs).toContain("/lib64");
		expect(paths.roDirs).toContain("/nix");
		expect(paths.roDirs).toContain("/etc/ssl");
		expect(paths.roDirs).not.toContain("/lib32");
		expect(paths.roDirs).not.toContain("/etc/ca-certificates");
	});

	it("arquivos /etc básicos sempre (resolv, hosts, passwd, group, nsswitch)", () => {
		const paths = computeSystemPaths(() => true);
		for (const f of ["/etc/resolv.conf", "/etc/hosts", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf"]) {
			expect(paths.etcFiles).toContain(f);
		}
	});

	it("inclui ld.so.cache/conf quando presentes (Debian/Ubuntu/Fedora)", () => {
		const paths = computeSystemPaths((p) => p === "/etc/ld.so.cache");
		expect(paths.etcFiles).toContain("/etc/ld.so.cache");
		expect(paths.etcFiles).not.toContain("/etc/ld.so.conf");
	});
});

describe("archTriplet", () => {
	it("mapeia process.arch para triplet GNU", () => {
		expect(archTriplet("x64")).toBe("x86_64");
		expect(archTriplet("arm64")).toBe("aarch64");
		expect(archTriplet("riscv64")).toBe("riscv64");
		expect(archTriplet("ia32")).toBe("i386");
	});

	it("passa arch desconhecida adiante", () => {
		expect(archTriplet("futuristic64")).toBe("futuristic64");
	});
});

describe("resolveLandlockExecPath", () => {
	const extDir = "/ext";
	const fakeExists = (paths: string[]) => (p: string) => paths.includes(p);

	it("prefere landlock-exec-<arch> empacotado", () => {
		const exists = fakeExists([join(extDir, "landlock-exec-aarch64"), join(extDir, "landlock-exec")]);
		expect(resolveLandlockExecPath(extDir, "aarch64", exists)).toBe(join(extDir, "landlock-exec-aarch64"));
	});

	it("cai para landlock-exec legado quando não há o específico", () => {
		const exists = fakeExists([join(extDir, "landlock-exec")]);
		expect(resolveLandlockExecPath(extDir, "x86_64", exists)).toBe(join(extDir, "landlock-exec"));
	});

	it("cai para target/release (build de desenvolvimento)", () => {
		const exists = fakeExists([join(extDir, "gen-seccomp", "target", "release", "landlock-exec")]);
		expect(resolveLandlockExecPath(extDir, "x86_64", exists)).toBe(
			join(extDir, "gen-seccomp", "target", "release", "landlock-exec"),
		);
	});

	it("retorna null quando nada existe", () => {
		expect(resolveLandlockExecPath(extDir, "x86_64", fakeExists([]))).toBeNull();
	});
});

describe("resolveSeccompBpfPath", () => {
	const extDir = "/ext";

	it("prefere seccomp-<arch>.bpf específico da arquitetura", () => {
		const exists = (p: string) => p === join(extDir, "seccomp-aarch64.bpf") || p === join(extDir, "seccomp.bpf");
		expect(resolveSeccompBpfPath(extDir, "aarch64", exists)).toBe(join(extDir, "seccomp-aarch64.bpf"));
	});

	it("cai para seccomp.bpf universal", () => {
		const exists = (p: string) => p === join(extDir, "seccomp.bpf");
		expect(resolveSeccompBpfPath(extDir, "x86_64", exists)).toBe(join(extDir, "seccomp.bpf"));
	});

	it("retorna null quando não há filtro", () => {
		expect(resolveSeccompBpfPath(extDir, "x86_64", () => false)).toBeNull();
	});
});

describe("probeUserNamespaces", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("retorna true quando unshare funciona", async () => {
		vi.doMock("node:child_process", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:child_process")>();
			return { ...actual, execFileSync: () => {} };
		});
		const m = await import("../portability");
		expect(m.probeUserNamespaces()).toBe(true);
	});

	it("retorna false quando unshare falha", async () => {
		vi.doMock("node:child_process", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:child_process")>();
			return {
				...actual,
				execFileSync: () => {
					throw new Error("EPERM");
				},
			};
		});
		const m = await import("../portability");
		expect(m.probeUserNamespaces()).toBe(false);
	});
});
