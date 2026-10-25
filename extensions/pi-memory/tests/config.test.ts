import { afterEach, describe, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "./expect-shim.ts";
import {
	clearModelProcessorConfig,
	getModelProcessorConfig,
	getSettingsModelConfig,
	loadMemoryConfig,
	resolveModelProcessorConfig,
	saveModelProcessorConfig,
} from "../memory/config.ts";

const dirs: string[] = [];

function trackDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-config-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memory config", () => {
	it("segue o settings.json quando não há override", () => {
		const dir = trackDir();
		const configPath = join(dir, "nested", "config.json");
		const settingsPath = join(dir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "muse-test" }),
		);
		expect(getModelProcessorConfig(configPath, settingsPath)).toEqual({
			provider: "opencode-go",
			id: "muse-test",
		});
		expect(resolveModelProcessorConfig(configPath, settingsPath).source).toBe("settings");
	});

	it("retorna null quando nem override nem settings existem", () => {
		const dir = trackDir();
		const configPath = join(dir, "config.json");
		const settingsPath = join(dir, "missing-settings.json");
		expect(getModelProcessorConfig(configPath, settingsPath)).toBe(null);
		expect(resolveModelProcessorConfig(configPath, settingsPath).source).toBe("none");
	});

	it("override de /memory config tem precedência sobre settings.json", () => {
		const dir = trackDir();
		const configPath = join(dir, "config.json");
		const settingsPath = join(dir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "muse-test" }),
		);
		saveModelProcessorConfig({ provider: "anthropic", id: "claude-test" }, configPath);
		expect(getModelProcessorConfig(configPath, settingsPath)).toEqual({
			provider: "anthropic",
			id: "claude-test",
		});
		expect(resolveModelProcessorConfig(configPath, settingsPath).source).toBe("override");
	});

	it("suporta defaultModel no formato provider/id", () => {
		const dir = trackDir();
		const settingsPath = join(dir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ defaultModel: "openai/gpt-test" }));
		expect(getSettingsModelConfig(settingsPath)).toEqual({
			provider: "openai",
			id: "gpt-test",
		});
	});

	it("clear remove o override e volta a seguir settings.json", () => {
		const dir = trackDir();
		const configPath = join(dir, "config.json");
		const settingsPath = join(dir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "muse-test" }),
		);
		saveModelProcessorConfig({ provider: "anthropic", id: "claude-test" }, configPath);
		clearModelProcessorConfig(configPath);
		expect(loadMemoryConfig(configPath)).toEqual({});
		expect(getModelProcessorConfig(configPath, settingsPath)).toEqual({
			provider: "opencode-go",
			id: "muse-test",
		});
	});

	it("persiste o modelo do processor e preserva opções futuras", () => {
		const dir = trackDir();
		const path = join(dir, "config.json");

		saveModelProcessorConfig({ provider: "anthropic", id: "claude-test" }, path);
		const saved = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		saved.futureOption = { enabled: true };
		writeFileSync(path, `${JSON.stringify(saved)}\n`);

		saveModelProcessorConfig({ provider: "openai", id: "gpt-test" }, path);
		expect(loadMemoryConfig(path)).toEqual({
			modelProcessor: { provider: "openai", id: "gpt-test" },
			futureOption: { enabled: true },
		});
	});

	it("ignora configuração inválida sem quebrar a leitura", () => {
		const dir = trackDir();
		const path = join(dir, "config.json");
		const settingsPath = join(dir, "missing-settings.json");
		writeFileSync(path, JSON.stringify({ modelProcessor: { provider: "", id: 42 } }));

		expect(loadMemoryConfig(path)).toEqual({});
		expect(getModelProcessorConfig(path, settingsPath)).toBe(null);
	});
});
