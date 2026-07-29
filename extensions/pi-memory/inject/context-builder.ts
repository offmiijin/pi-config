/**
 * Context Builder — Constrói bloco de memória para injeção no system prompt.
 * Usa RetrievalResult baseado em Page.
 */

import type { RetrievalResult } from "../types";

// ── Constantes ─────────────────────────────────────────────────────────

const MAX_BLOCK_BYTES = 4096; // 4KB
const MAX_MEMORIES = 5;

// ── buildMemoryBlock ──────────────────────────────────────────────────

export function buildMemoryBlock(
  results: RetrievalResult[],
  maxBytes = MAX_BLOCK_BYTES
): string {
  if (results.length === 0) return "";

  const header = "## Persistent Memory\n";
  let body = header;
  let count = 0;

  for (const r of results) {
    if (count >= MAX_MEMORIES) break;

    const bullet = `- [${r.page.type}] ${r.page.title}\n`;

    if (Buffer.byteLength(body + bullet) > maxBytes) break;

    body += bullet;
    count++;
  }

  if (count === 0) return "";
  return body.trimEnd();
}

// ── Handler: before_agent_start ───────────────────────────────────────

export type SearchFn = (
  query: string,
  topK?: number
) => Promise<RetrievalResult[]>;

export interface InjectHandlerOptions {
  search: SearchFn;
  maxBytes?: number;
  topK?: number;
}

export function createInjectHandler(options: InjectHandlerOptions) {
  const { search, maxBytes = MAX_BLOCK_BYTES, topK = 10 } = options;

  return async (event: { prompt: string; systemPrompt: string }) => {
    const results = await search(event.prompt, topK);
    if (results.length === 0) return { systemPrompt: event.systemPrompt };

    const relevant = results.filter((r) => r.page.confidence >= 0.5);
    if (relevant.length === 0) return { systemPrompt: event.systemPrompt };

    const block = buildMemoryBlock(relevant, maxBytes);
    if (!block) return { systemPrompt: event.systemPrompt };

    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  };
}

// ── Private ───────────────────────────────────────────────────────────
