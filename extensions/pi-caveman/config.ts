import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CavemanConfig } from "./types.ts";

const DEFAULT_MIN_BYTES = 2 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MIN_SAVINGS_BYTES = 64;

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.PI_CAVEMAN_HOME?.trim();
	if (explicit) return resolve(explicit);
	return join(homedir(), ".pi", "agent", "pi-caveman");
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): CavemanConfig {
	return {
		enabled: env.PI_CAVEMAN_ENABLED !== "0",
		minBytes: DEFAULT_MIN_BYTES,
		maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
		minSavingsBytes: DEFAULT_MIN_SAVINGS_BYTES,
		dataDir: defaultDataDir(env),
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CavemanConfig {
	const base = defaultConfig(env);
	const path = join(base.dataDir, "config.json");
	if (!existsSync(path)) return base;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
			minBytes: positiveInteger(raw.minBytes, base.minBytes),
			maxInputBytes: positiveInteger(raw.maxInputBytes, base.maxInputBytes),
			minSavingsBytes: positiveInteger(raw.minSavingsBytes, base.minSavingsBytes),
			dataDir: base.dataDir,
		};
	} catch {
		return base;
	}
}
