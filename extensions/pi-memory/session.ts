/**
 * pi-memory — Helpers de sessão e estimativa de tokens.
 *
 * O pipeline antigo de observações markdown (turn_dedup, formatação de
 * observações, arquivo de sessão em sessions/*.md, threshold 50) foi
 * substituído pelas Fases 0-6: a fonte bruta é o JSONL do Pi (lido por
 * evidence.ts) e memórias duram em snapshot v2. Aqui restam apenas helpers
 * usados pelo pipeline atual.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { CHARS_PER_TOKEN } from "./constants.ts";

/**
 * Gera um hash curto e estável a partir do caminho do arquivo de sessão.
 */
export function hashSessionFile(sessionFile: string): string {
	return createHash("sha256").update(sessionFile).digest("hex").slice(0, 12);
}

/**
 * Gera um hash de sessão aleatório (sessões efêmeras sem arquivo).
 */
export function generateSessionHash(): string {
	return createHash("sha256")
		.update(`${Date.now()}_${Math.random()}`)
		.digest("hex")
		.slice(0, 12);
}

/**
 * Estima a contagem de tokens de um texto com heurística de chars por token.
 * Aproximação — não é um tokenizador real.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Garante que o diretório do arquivo exista, criando se necessário.
 */
export function ensureFileDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
