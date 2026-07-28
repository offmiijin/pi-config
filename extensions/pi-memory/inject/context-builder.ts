/**
 * Context Builder — Constrói bloco de memória para injeção no system prompt.
 *
 * Fase 1: injeção simples. Bloco formatado com top-N memórias, cap 4KB.
 * Fase 2+: KV Cache-Stable Snapshot (ADR-006).
 */

import type { Memory, RetrievalResult } from "../types";

// ── Constantes ─────────────────────────────────────────────────────────

/** Tamanho máximo do bloco de memória injetado (bytes) */
const MAX_BLOCK_BYTES = 4096; // 4KB

/** Número máximo de memórias no bloco */
const MAX_MEMORIES = 5;

/** Máximo de caracteres no texto de cada bullet */
const MAX_BULLET_LENGTH = 200;

// ── buildMemoryBlock ──────────────────────────────────────────────────

/**
 * Formata uma lista de memórias como bullet points para injeção no system prompt.
 * Trunca bullets e bloco total ao limite de bytes.
 *
 * @param memories - Lista de memórias (já ordenadas por relevância)
 * @param maxBytes - Limite de bytes do bloco (default: 4KB)
 * @returns String formatada ou "" se array vazio
 */
export function buildMemoryBlock(
  memories: Memory[],
  maxBytes = MAX_BLOCK_BYTES
): string {
  if (memories.length === 0) return "";

  const header = "## Persistent Memory\n";
  let body = header;
  let count = 0;

  for (const mem of memories) {
    if (count >= MAX_MEMORIES) break;

    const preview = truncateText(mem.text, MAX_BULLET_LENGTH);
    const bullet = `- [${mem.type}] ${preview}\n`;

    if (Buffer.byteLength(body + bullet) > maxBytes) break;

    body += bullet;
    count++;
  }

  if (count === 0) return "";
  return body.trimEnd();
}

/**
 * Formata resultados de retrieval como bloco de contexto.
 * Conveniência: extrai memories de RetrievalResult[].
 */
export function buildMemoryBlockFromResults(
  results: RetrievalResult[],
  maxBytes = MAX_BLOCK_BYTES
): string {
  const memories = results.slice(0, MAX_MEMORIES).map((r) => r.memory);
  return buildMemoryBlock(memories, maxBytes);
}

// ── Handler: before_agent_start ───────────────────────────────────────

/** Função de busca genérica (assíncrona) */
export type SearchFn = (
  query: string,
  topK?: number
) => Promise<RetrievalResult[]>;

export interface InjectHandlerOptions {
  /** Função de busca (wrapped Bm25Retriever ou HybridRetriever) */
  search: SearchFn;
  /** ID do projeto atual */
  projectId: string;
  /** Tamanho máximo do bloco injetado (default: 4KB) */
  maxBytes?: number;
  /** Número de resultados a buscar (default: 10) */
  topK?: number;
}

/**
 * Cria handler de `before_agent_start` que injeta memórias no system prompt.
 *
 * Fluxo:
 *   1. Extrai prompt do evento
 *   2. Busca memórias via BM25
 *   3. Se houver resultados, formata bloco e injeta no systemPrompt
 *   4. Se não houver, retorna systemPrompt original
 */
export function createInjectHandler(options: InjectHandlerOptions) {
  const { search, projectId, maxBytes = MAX_BLOCK_BYTES, topK = 10 } = options;

  return async (event: { prompt: string; systemPrompt: string }) => {
    const query = event.prompt;

    // Busca memórias (assíncrona)
    const results = await search(query, topK);

    if (results.length === 0) {
      return { systemPrompt: event.systemPrompt };
    }

    // Filtra por confidence mínima (ADR-006: só injeta se confiante)
    const relevant = results.filter((r) => r.memory.confidence >= 0.5);

    if (relevant.length === 0) {
      return { systemPrompt: event.systemPrompt };
    }

    // Constrói bloco
    const block = buildMemoryBlockFromResults(relevant, maxBytes);

    if (!block) {
      return { systemPrompt: event.systemPrompt };
    }

    // Injeta no system prompt
    return {
      systemPrompt: `${event.systemPrompt}\n\n${block}`,
    };
  };
}

// ── Private ───────────────────────────────────────────────────────────

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "…";
}
