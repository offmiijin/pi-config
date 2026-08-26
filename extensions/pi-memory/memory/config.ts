/**
 * Configuração persistente da extensão pi-memory.
 *
 * O arquivo é global ao usuário e guarda apenas referências a modelos. As
 * credenciais continuam sob responsabilidade do modelRegistry do Pi.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
	EXTRACTION_MODEL_ID,
	EXTRACTION_MODEL_PROVIDER,
} from "../config.ts";

export const MEMORY_CONFIG_PATH = join(getAgentDir(), "memory-config.json");

export interface MemoryModelConfig {
	provider: string;
	id: string;
}

export interface MemoryConfig {
	/** Modelo usado pelo worker de extração e revisão. */
	modelProcessor?: MemoryModelConfig;
	/** Reservado para futuras opções de /memory config. */
	[key: string]: unknown;
}

/** Configuração padrão preservando o modelo anterior da extensão. */
export const DEFAULT_MODEL_PROCESSOR: MemoryModelConfig = {
	provider: EXTRACTION_MODEL_PROVIDER,
	id: EXTRACTION_MODEL_ID,
};

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

/** Lê a configuração global; arquivo ausente ou inválido volta ao default. */
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

/** Retorna o modelo configurado ou o modelo fixo legado como fallback. */
export function getModelProcessorConfig(filePath: string = MEMORY_CONFIG_PATH): MemoryModelConfig {
	return loadMemoryConfig(filePath).modelProcessor ?? DEFAULT_MODEL_PROCESSOR;
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
