/**
 * Pi Doctor — testes unitários (degradação e mapeamentos).
 *
 * Cobre: detecção de pacotes ausentes, binários ausentes (mock de
 * spawnSync), mapeamento de distro (parseOsRelease/detectPackageManager),
 * installHint por gerenciador, formato do relatório e skip de rede.
 */

import { describe, it, expect, vi } from "vitest";

// ── Mock do spawnSync (binários) ─────────────────────────────────────────
// Por padrão tudo "instalado"; testes desligam comandos específicos.
const { binMocks } = vi.hoisted(() => ({
	binMocks: {} as Record<string, { status: number; stdout?: string; errno?: string }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: (cmd: string) => {
			const m = binMocks[cmd];
			if (!m) return { status: 0, stdout: "mock 1.0\n", error: undefined };
			if (m.errno) return { status: -1, stdout: "", error: { code: m.errno } };
			return { status: m.status, stdout: m.stdout ?? "", error: undefined };
		},
	};
});

import {
	runChecks,
	buildReportText,
	parseOsRelease,
	detectPackageManager,
	installHint,
	resolvePackage,
	defaultPkgRoots,
} from "../pi-doctor";

describe("resolvePackage", () => {
	it("encontra pacote em uma raiz node_modules", () => {
		const roots = defaultPkgRoots();
		// No CI/dev as deps estão hoisted na raiz do workspace
		expect(resolvePackage(roots, "@earendil-works/pi-coding-agent")).not.toBeNull();
	});

	it("retorna null quando o pacote não existe", () => {
		expect(resolvePackage(["/nonexistent/node_modules"], "typebox")).toBeNull();
	});
});

describe("runChecks — degradação (6.3)", () => {
	it("pacotes npm ausentes → erro com fix npm ci", async () => {
		const checks = await runChecks({ pkgRoots: ["/nonexistent/node_modules"], skipNetwork: true });
		const npmPkgs = checks.find((c) => c.id === "npm-packages")!;
		expect(npmPkgs.status).toBe("error");
		expect(npmPkgs.detail).toContain("ausentes");
		expect(npmPkgs.fix).toContain("npm ci");
	});

	it("bwrap ausente → erro (fail-closed) com hint de instalação", async () => {
		binMocks["bwrap"] = { status: 1, errno: "ENOENT" };
		const checks = await runChecks({ skipNetwork: true });
		const bwrap = checks.find((c) => c.id === "bwrap")!;
		expect(bwrap.status).toBe("error");
		expect(bwrap.fix).toContain("bubblewrap");
		delete binMocks["bwrap"];
	});

	it("ripgrep ausente → warn (não erro)", async () => {
		binMocks["rg"] = { status: 1, errno: "ENOENT" };
		const checks = await runChecks({ skipNetwork: true });
		const rg = checks.find((c) => c.id === "rg")!;
		expect(rg.status).toBe("warn");
		delete binMocks["rg"];
	});

	it("pdftotext ausente → warn (não erro) com hint poppler", async () => {
		binMocks["pdftotext"] = { status: 1, errno: "ENOENT" };
		const checks = await runChecks({ skipNetwork: true, pm: "apt" });
		const pdftotext = checks.find((c) => c.id === "pdftotext")!;
		expect(pdftotext.status).toBe("warn");
		expect(pdftotext.fix).toContain("poppler-utils");
		delete binMocks["pdftotext"];
	});

	it("pdftotext presente → ok com versão", async () => {
		binMocks["pdftotext"] = { status: 0, stdout: "" };
		const checks = await runChecks({ skipNetwork: true });
		const pdftotext = checks.find((c) => c.id === "pdftotext")!;
		expect(pdftotext.status).toBe("ok");
		delete binMocks["pdftotext"];
	});

	it("ambiente completo → deps e sandbox sem pendências", async () => {
		// (node version é dependente do ambiente — não asserta aqui)
		const checks = await runChecks({ skipNetwork: true });
		const npmPkgs = checks.find((c) => c.id === "npm-packages")!;
		const bwrap = checks.find((c) => c.id === "bwrap")!;
		expect(npmPkgs.status).not.toBe("error");
		expect(bwrap.status).not.toBe("error");
	});

	it("skipNetwork=true não inclui checagem de rede do SearXNG", async () => {
		const checks = await runChecks({ skipNetwork: true });
		expect(checks.find((c) => c.id === "searxng")).toBeUndefined();
	});
});

describe("distro mapping", () => {
	it("parseOsRelease lê ID/ID_LIKE/NAME", () => {
		const os = parseOsRelease('NAME="Arch Linux"\nID=arch\nID_LIKE="archlinux"\n');
		expect(os.id).toBe("arch");
		expect(os.name).toBe("Arch Linux");
	});

	it("detectPackageManager mapeia as principais distros", () => {
		const cases: Array<[string, string | null]> = [
			['ID=debian\nID_LIKE=""', "apt"],
			['ID=ubuntu\nID_LIKE=debian', "apt"],
			['ID=fedora\nID_LIKE=fedora', "dnf"],
			['ID=arch\nID_LIKE=""', "pacman"],
			['ID=opensuse-leap\nID_LIKE="suse opensuse"', "zypper"],
			['ID=nixos\nID_LIKE=""', null],
		];
		for (const [raw, expected] of cases) {
			expect(detectPackageManager(parseOsRelease(raw))).toBe(expected);
		}
	});

	it("installHint por gerenciador (nomes de pacote corretos)", () => {
		expect(installHint("pacman", "gh")).toBe("sudo pacman -S github-cli");
		expect(installHint("apt", "bubblewrap")).toBe("sudo apt install bubblewrap");
		expect(installHint(null, "git")).toContain("Instale");
	});
});

describe("buildReportText", () => {
	it("formata ok/erro com Fix e resumo de pendências", () => {
		const checks = [
			{ id: "npm-packages", label: "Pacotes npm", status: "error" as const, detail: "ausentes: typebox", fix: "cd /x && npm ci" },
			{ id: "node", label: "Node runtime", status: "ok" as const, detail: "v22.5.0" },
		];
		const text = buildReportText(checks, { id: "arch", idLike: [], name: "Arch" }, "pacman");
		expect(text).toContain("❌ Pacotes npm: ausentes: typebox");
		expect(text).toContain("Fix: cd /x && npm ci");
		expect(text).toContain("1 pendência(s)");
		expect(text).toContain("✅ Node runtime: v22.5.0");
	});
});
