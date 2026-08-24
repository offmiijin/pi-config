/**
 * Tests for auth.ts
 *
 * Covers: getInstallGuide, getAuthInfo
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getInstallGuide } from "../auth";

// Mock node:fs at top level (vitest hoists vi.mock)
const mockFs = vi.hoisted(() => {
	return {
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
	};
});

vi.mock("node:fs", () => mockFs);

// getInstallGuide
describe("getInstallGuide", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// ── macOS ────────────────────────────────────────────────────────
	it("returns brew command on macOS", () => {
		vi.stubGlobal("process", { ...process, platform: "darwin" });
		expect(getInstallGuide()).toBe("`brew install gh`");
	});

	// ── Windows ──────────────────────────────────────────────────────
	it("returns winget command on Windows", () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });
		expect(getInstallGuide()).toBe("`winget install GitHub.cli`");
	});

	// ── Linux ────────────────────────────────────────────────────────
	it("returns pacman command for Arch Linux", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID="arch"\n');
		expect(getInstallGuide()).toBe("`pacman -S github-cli`");
	});

	it("returns pacman command for EndeavourOS", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID="endeavouros"\n');
		expect(getInstallGuide()).toBe("`pacman -S github-cli`");
	});

	it("returns pacman command for Manjaro (via ID_LIKE)", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID=manjaro\nID_LIKE=arch\n');
		expect(getInstallGuide()).toBe("`pacman -S github-cli`");
	});

	it("returns apt command for Ubuntu", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID=ubuntu\n');
		expect(getInstallGuide()).toBe("`apt install gh`");
	});

	it("returns apt command for Debian", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID="debian"\n');
		expect(getInstallGuide()).toBe("`apt install gh`");
	});

	it("returns apt command for Pop!_OS (via ID_LIKE)", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID=pop\nID_LIKE="ubuntu debian"\n');
		expect(getInstallGuide()).toBe("`apt install gh`");
	});

	it("returns dnf command for Fedora", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID=fedora\n');
		expect(getInstallGuide()).toBe("`dnf install gh`");
	});

	it("returns yum command for RHEL", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID="rhel"\n');
		expect(getInstallGuide()).toBe("`yum install gh`");
	});

	it("returns yum command for CentOS", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID="centos"\n');
		expect(getInstallGuide()).toBe("`yum install gh`");
	});

	it("returns zypper command for openSUSE", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID="opensuse"\n');
		expect(getInstallGuide()).toBe("`zypper install gh`");
	});

	it("returns apk command for Alpine", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID="alpine"\n');
		expect(getInstallGuide()).toBe("`apk add github-cli`");
	});

	it("returns docs URL for unknown Linux distro", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('ID="unknown-distro"\n');
		expect(getInstallGuide()).toBe(
			"https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
		);
	});

	it("returns docs URL when /etc/os-release does not exist", () => {
		vi.stubGlobal("process", { ...process, platform: "linux" });
		mockFs.existsSync.mockReturnValue(false);
		expect(getInstallGuide()).toBe(
			"https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
		);
	});

	// ── Fallback genérico ────────────────────────────────────────────
	it("returns generic docs URL for unknown platform", () => {
		vi.stubGlobal("process", { ...process, platform: "freebsd" });
		expect(getInstallGuide()).toBe("https://github.com/cli/cli#installation");
	});
});