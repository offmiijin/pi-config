import { afterEach, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "./expect-shim.ts";
import {
	DEFAULT_MODEL_PROCESSOR,
	getModelProcessorConfig,
	loadMemoryConfig,
	saveModelProcessorConfig,
} from "../memory/config.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memory config", () => {
	it("usa o modelo padrão quando a configuração não existe", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-config-"));
		const path = join(dir, "nested", "config.json");
		const config = getModelProcessorConfig(path);
		dirs.push(dir);
		expect(config).toEqual(DEFAULT_MODEL_PROCESSOR);
	});

	it("persiste o modelo do processor e preserva opções futuras", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-config-"));
		const path = join(dir, "config.json");
		dirs.push(dir);

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
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-config-"));
		const path = join(dir, "config.json");
		dirs.push(dir);
		writeFileSync(path, JSON.stringify({ modelProcessor: { provider: "", id: 42 } }));

		expect(loadMemoryConfig(path)).toEqual({});
		expect(getModelProcessorConfig(path)).toEqual(DEFAULT_MODEL_PROCESSOR);
	});
});
