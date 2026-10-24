/**
 * Configuração persistente da extensão pi-memory.
 *
 * O arquivo é global ao usuário e guarda apenas referências a modelos. As
 * credenciais continuam sob responsabilidade do modelRegistry do Pi.
 *
 * Resolução do modelo de extração:
 * 1. override explícito em memory-config.json (via /memory config), ou
 * 2. modelo atual do usuário em settings.json (defaultProvider + defaultModel).
 * Sem nenhum dos dois, retorna null — o job fica retryável até haver modelo.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MEMORY_CONFIG_PATH = join(getAgentDir(), "memory-config.json");
export const SETTINGS_PATH = join(getAgentDir(), "settings.json");

export interface MemoryModelConfig {
	provider: string;
	id: string;
}

export interface MemoryConfig {
	/** Override explícito do modelo usado pelo worker de extração e revisão. */
	modelProcessor?: MemoryModelConfig;
	/** Reservado para futuras opções de /memory config. */
	[key: string]: unknown;
}

function isModelConfig(value: unknown): value is MemoryModelConfig {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.provider === "string" &&
		candidate.provider.trim().length > 0 &&
		typeof candidate.id === "string" &&
		candidate.id.trim().length > 0
	);
}

/** Lê a configuração global; arquivo ausente ou inválido volta a {}. */
export function loadMemoryConfig(filePath: string = MEMORY_CONFIG_PATH): MemoryConfig {
	if (!existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const raw = parsed as Record<string, unknown>;
		const config: MemoryConfig = { ...raw };
		if (isModelConfig(raw.modelProcessor)) {
			config.modelProcessor = {
				provider: raw.modelProcessor.provider,
				id: raw.modelProcessor.id,
			};
		} else {
			delete config.modelProcessor;
		}
		return config;
	} catch {
		return {};
	}
}

/**
 * Lê o modelo atual do usuário em settings.json
 * (defaultProvider + defaultModel). defaultModel aceita "id" puro ou
 * "provider/id" — a forma "provider/id" tem precedência sobre defaultProvider.
 * Retorna null quando settings.json está ausente/incompleto.
 */
export function getSettingsModelConfig(
	settingsPath: string = SETTINGS_PATH,
): MemoryModelConfig | null {
	try {
		if (!existsSync(settingsPath)) return null;
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const raw = parsed as Record<string, unknown>;
		const defaultModel = typeof raw.defaultModel === "string" ? raw.defaultModel.trim() : "";
		const defaultProvider =
			typeof raw.defaultProvider === "string" ? raw.defaultProvider.trim() : "";
		if (!defaultModel) return null;
		if (defaultModel.includes("/")) {
			const [provider, ...rest] = defaultModel.split("/");
			const id = rest.join("/").trim();
			if (!provider.trim() || !id) return null;
			return { provider: provider.trim(), id };
		}
		if (!defaultProvider) return null;
		return { provider: defaultProvider, id: defaultModel };
	} catch {
		return null;
	}
}

export type ModelProcessorSource = "override" | "settings" | "none";

/** Retorna o override explícito + a fonte da resolução efetiva. */
export function resolveModelProcessorConfig(
	filePath: string = MEMORY_CONFIG_PATH,
	settingsPath: string = SETTINGS_PATH,
): { model: MemoryModelConfig | null; source: ModelProcessorSource } {
	const override = loadMemoryConfig(filePath).modelProcessor;
	if (override) return { model: override, source: "override" };
	const fromSettings = getSettingsModelConfig(settingsPath);
	if (fromSettings) return { model: fromSettings, source: "settings" };
	return { model: null, source: "none" };
}

/**
 * Retorna o modelo de extração efetivo: override de /memory config ou o
 * modelo atual do usuário (settings.json). Null quando nenhum está disponível.
 */
export function getModelProcessorConfig(
	filePath: string = MEMORY_CONFIG_PATH,
	settingsPath: string = SETTINGS_PATH,
): MemoryModelConfig | null {
	return resolveModelProcessorConfig(filePath, settingsPath).model;
}

/**
 * Persiste somente referências de modelo, preservando futuras opções do
 * arquivo. A escrita usa temporário + rename no mesmo diretório.
 */
export function saveModelProcessorConfig(
	model: MemoryModelConfig,
	filePath: string = MEMORY_CONFIG_PATH,
): void {
	if (!isModelConfig(model)) throw new Error("modelo de processamento inválido");
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true });
	const current = loadMemoryConfig(filePath);
	const next: MemoryConfig = {
		...current,
		modelProcessor: { provider: model.provider, id: model.id },
	};
	const tmpPath = `${filePath}.tmp`;
	try {
		writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
		renameSync(tmpPath, filePath);
	} catch (err) {
		rmSync(tmpPath, { force: true });
		throw err;
	}
}

/**
 * Remove o override explícito — a extração volta a seguir o modelo atual
 * do usuário (settings.json). Preserva as demais opções do arquivo.
 */
export function clearModelProcessorConfig(filePath: string = MEMORY_CONFIG_PATH): void {
	const current = loadMemoryConfig(filePath);
	if (!current.modelProcessor) return;
	const { modelProcessor: _removed, ...rest } = current;
	const tmpPath = `${filePath}.tmp`;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(tmpPath, `${JSON.stringify(rest, null, 2)}\n`);
		renameSync(tmpPath, filePath);
	} catch (err) {
		rmSync(tmpPath, { force: true });
		throw err;
	}
}
