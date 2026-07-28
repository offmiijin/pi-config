/**
 * Bm25Retriever — Retrieval lexical via SQLite FTS5 + BM25.
 *
 * Wrapper sobre IStorage.searchFts que normaliza scores e formata resultados.
 * Fase 1: apenas BM25. Fase 2+: integrar com vector search + RRF.
 */

import type { Memory, RetrievalResult } from "../types";
import type { IStorage } from "../storage/index";

/** Máximo de caracteres no preview de texto para injeção */
const MAX_PREVIEW_LENGTH = 200;

export class Bm25Retriever {
  private storage: IStorage;

  constructor(storage: IStorage) {
    this.storage = storage;
  }

  /**
   * Busca memórias via FTS5 BM25.
   *
   * @param query - Texto de busca (prompt do usuário ou consulta)
   * @param projectId - ID do projeto para filtrar
   * @param topK - Número máximo de resultados (default: 10)
   * @returns Resultados ranqueados com score normalizado 0-1
   */
  search(
    query: string,
    projectId: string,
    topK = 10
  ): RetrievalResult[] {
    const raw = this.storage.searchFts(query, projectId, topK);

    if (raw.length === 0) return [];

    // Normaliza scores BM25 para range 0-1
    return this.normalizeScores(raw);
  }

  /**
   * Formata resultados para injeção no system prompt.
   * Formato: bullet points com type e texto truncado.
   *
   * @param results - Resultados de retrieval
   * @param maxResults - Máximo de bullets (default: 5)
   * @returns String formatada para injeção
   */
  formatResults(results: RetrievalResult[], maxResults = 5): string {
    if (results.length === 0) return "";

    const top = results.slice(0, maxResults);

    const bullets = top.map((r) => {
      const text = this.truncateText(r.memory.text, MAX_PREVIEW_LENGTH);
      return `- [${r.memory.type}] ${text}`;
    });

    // Ordena por tipo para agrupamento visual: preference, decision, lesson, fact, pattern
    bullets.sort((a, b) => {
      const typeOrder: Record<string, number> = {
        preference: 0,
        decision: 1,
        pattern: 2,
        lesson: 3,
        fact: 4,
      };
      const typeA = a.match(/\[(\w+)\]/)?.[1] ?? "";
      const typeB = b.match(/\[(\w+)\]/)?.[1] ?? "";
      return (typeOrder[typeA] ?? 9) - (typeOrder[typeB] ?? 9);
    });

    return bullets.join("\n");
  }

  /**
   * Formata um bloco de contexto de memória para o system prompt.
   * Inclui cabeçalho e bullets, respeitando limite de bytes.
   *
   * @param results - Resultados ordenados por score
   * @param maxBytes - Limite de bytes do bloco (default: 4096 = 4KB)
   * @returns Bloco formatado para injeção
   */
  formatContextBlock(results: RetrievalResult[], maxBytes = 4096): string {
    if (results.length === 0) return "";

    const header = `## Persistent Memory (auto-injected)\n`;
    const footer = ``;
    let body = header;
    const top = results.slice(0, 10);

    for (const r of top) {
      const text = this.truncateText(r.memory.text, MAX_PREVIEW_LENGTH);
      const bullet = `- [${r.memory.type}] ${text}\n`;

      if (Buffer.byteLength(body + bullet + footer) > maxBytes) break;
      body += bullet;
    }

    return body.trimEnd();
  }

  // ── Private ────────────────────────────────────────────────────────

  /**
   * Normaliza scores BM25 para range 0-1 usando min-max no result set.
   * Se apenas 1 resultado, score = 1.0.
   */
  private normalizeScores(
    raw: Array<{ memory: Memory; bm25Score: number }>
  ): RetrievalResult[] {
    if (raw.length === 1) {
      return [{ memory: raw[0].memory, score: 1.0, strategy: "bm25" }];
    }

    const scores = raw.map((r) => r.bm25Score);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const range = maxScore - minScore;

    return raw.map((r) => ({
      memory: r.memory,
      score: range === 0 ? 0.5 : (r.bm25Score - minScore) / range,
      strategy: "bm25" as const,
    }));
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + "…";
  }
}
