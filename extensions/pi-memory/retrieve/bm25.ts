/**
 * Bm25Retriever — Retrieval lexical via SQLite FTS5 + BM25 sobre páginas.
 *
 * Wrapper sobre IStorage.searchPagesFts que normaliza scores e formata resultados.
 */

import type { RetrievalResult } from "../types";
import type { IStorage } from "../storage/index";

/** Máximo de caracteres no preview de texto para injeção */
const MAX_PREVIEW_LENGTH = 200;

export class Bm25Retriever {
  private storage: IStorage;

  constructor(storage: IStorage) {
    this.storage = storage;
  }

  /**
   * Busca páginas via FTS5 BM25.
   *
   * @param query - Texto de busca
   * @param projectId - ID do projeto para filtrar
   * @param topK - Número máximo de resultados (default: 10)
   * @returns Resultados ranqueados com score normalizado 0-1
   */
  search(
    query: string,
    projectId: string,
    topK = 10
  ): RetrievalResult[] {
    const raw = this.storage.searchPagesFts(query, projectId, topK);

    if (raw.length === 0) return [];

    // Scores já normalizados pelo SqliteStore. Re-normaliza por segurança.
    return this.normalizeScores(raw);
  }

  /**
   * Formata resultados para injeção no system prompt.
   * Formato: bullet points com type e texto truncado.
   */
  formatResults(results: RetrievalResult[], maxResults = 5): string {
    if (results.length === 0) return "";

    const top = results.slice(0, maxResults);

    const bullets = top.map((r) => {
      const text = this.truncateText(r.page.body, MAX_PREVIEW_LENGTH);
      return `- [${r.page.type}] ${text}`;
    });

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
   */
  formatContextBlock(results: RetrievalResult[], maxBytes = 4096): string {
    if (results.length === 0) return "";

    const header = `## Persistent Memory (auto-injected)\n`;
    const footer = ``;
    let body = header;
    const top = results.slice(0, 10);

    for (const r of top) {
      const text = this.truncateText(r.page.body, MAX_PREVIEW_LENGTH);
      const bullet = `- [${r.page.type}] ${text}\n`;

      if (Buffer.byteLength(body + bullet + footer) > maxBytes) break;
      body += bullet;
    }

    return body.trimEnd();
  }

  // ── Private ────────────────────────────────────────────────────────

  private normalizeScores(raw: RetrievalResult[]): RetrievalResult[] {
    if (raw.length === 1) {
      return [{ ...raw[0], score: 1.0 }];
    }

    const scores = raw.map((r) => r.score);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const range = maxScore - minScore;

    return raw.map((r) => ({
      ...r,
      score: range === 0 ? 0.5 : (r.score - minScore) / range,
    }));
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + "…";
  }
}
