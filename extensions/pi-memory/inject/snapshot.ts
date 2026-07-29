/**
 * CacheStableInjector — KV Cache-Stable Snapshot, ADR-006, Fase 2.6.
 *
 * O bloco de memória injetado no system prompt é congelado e só
 * reconstruído em checkpoints estratégicos. Isso evita invalidar
 * o KV cache do provider a cada turno, reduzindo custo e latência.
 *
 * Checkpoints de invalidação:
 *   - session_start          → novo contexto, rebuild obrigatório
 *   - session_before_compact  → handoff capturado, snapshot rebuild
 *   - memory_write (long_term) → mudança intencional
 *   - day rollover            → daily log mudou (data nos headers)
 *
 * NÃO invalida:
 *   - memory_search call      → busca explícita, não afeta injeção
 *   - tool_result qualquer    → captura não muda o que é injetado
 *
 * Formato do bloco (ADR-006):
 *   ## Scratchpad (até 2KB)       — stub, Fase 3
 *   ## Today (até 3KB, tail)      — stub, Fase 3
 *   ## Persistent Memory (até 4KB)
 *   ## Yesterday (até 3KB, tail)  — stub, Fase 3
 *   Cap total: 16KB (~4K tokens)
 */

import type { RetrievalResult } from "../types";

// ── Config ─────────────────────────────────────────────────────────────

export interface CacheStableConfig {
  /** Cap total do bloco injetado em bytes. Default: 16KB */
  totalCapBytes: number;
  /** Cap da seção Persistent Memory em bytes. Default: 4KB */
  persistentMemCapBytes: number;
  /** Máximo de bullets na seção Persistent Memory. Default: 8 */
  maxBullets: number;
  /** Threshold de confidence para incluir memória. Default: 0.5 */
  confidenceThreshold: number;
  /** Ativar log de cache hits/misses (debug) */
  debug: boolean;
}

const DEFAULTS: CacheStableConfig = {
  totalCapBytes: 16 * 1024, // 16KB
  persistentMemCapBytes: 4 * 1024, // 4KB
  maxBullets: 8,
  confidenceThreshold: 0.5,
  debug: false,
};

// ── Seção do bloco ─────────────────────────────────────────────────────

interface Section {
  /** Nome da seção (ex: "## Persistent Memory") */
  header: string;
  /** Conteúdo da seção */
  body: string;
  /** Prioridade: menor = mais importante (ordem no bloco) */
  priority: number;
}

// ── CacheStableInjector ────────────────────────────────────────────────

export class CacheStableInjector {
  private cached: string | null = null;
  private cacheAgeMs = 0;
  private cacheBuiltAt = 0;
  private turnsSinceRebuild = 0;
  private lastDay = "";
  private readonly config: CacheStableConfig;

  /** Seções customizadas (ex: scratchpad, daily). Map de header → body. */
  private customSections = new Map<string, string>();

  /**
   * Função de busca: (query) => Promise<RetrievalResult[]>
   * Chamada no rebuild para popular a seção Persistent Memory.
   */
  private readonly searchFn: (
    query: string
  ) => Promise<RetrievalResult[]>;

  constructor(
    searchFn: (query: string) => Promise<RetrievalResult[]>,
    config: Partial<CacheStableConfig> = {}
  ) {
    this.searchFn = searchFn;
    this.config = { ...DEFAULTS, ...config };
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Obtém o bloco de memória para injeção.
   *
   * Reusa cache se ainda válido. Reconstrói se checkpoint de invalidação
   * foi atingido (session_start, day rollover, ou invalidate() chamado).
   *
   * @param prompt - Prompt do usuário (query para Persistent Memory)
   * @returns Bloco formatado pronto para injeção no system prompt
   */
  async getMemoryBlock(prompt: string): Promise<string> {
    // Filtra prompts triviais (ex: "continue", "ok")
    const effectiveQuery = this.isTrivialPrompt(prompt) ? "" : prompt;

    if (this.shouldRebuild()) {
      this.cached = await this.buildMemoryBlock(effectiveQuery);
      this.cacheBuiltAt = Date.now();
      this.turnsSinceRebuild = 0;

      if (this.config.debug) {
        const size = Buffer.byteLength(this.cached);
        console.warn(
          `[pi-memory] Cache rebuilt: ${size}B, sections: ${this.customSections.size + 1}`
        );
      }
    }

    this.turnsSinceRebuild++;
    this.cacheAgeMs = Date.now() - this.cacheBuiltAt;

    return this.cached ?? "";
  }

  /**
   * Invalida o cache forçando rebuild no próximo getMemoryBlock().
   * Chamado após memory_write, session_before_compact, etc.
   */
  invalidate(): void {
    this.cached = null;
    if (this.config.debug) {
      console.warn("[pi-memory] Cache invalidated (explicit)");
    }
  }

  /**
   * Define ou atualiza uma seção customizada (ex: scratchpad, daily log).
   * Chamar isto NÃO invalida o cache automaticamente — use invalidate()
   * se a seção deve aparecer no próximo bloco.
   *
   * @param header - Título da seção (ex: "## Scratchpad")
   * @param body - Conteúdo em markdown
   * @param priority - Ordem no bloco (default: 10)
   */
  setSection(header: string, body: string, priority = 10): void {
    this.customSections.set(header, body);
    // Armazena priority via key composta (não exposto no Map)
    this.customSections.set(`__priority__${header}`, String(priority));
  }

  /** Remove uma seção customizada */
  removeSection(header: string): void {
    this.customSections.delete(header);
    this.customSections.delete(`__priority__${header}`);
  }

  // ── Stats ────────────────────────────────────────────────────────

  /** Idade do cache atual em ms */
  get cacheAge(): number {
    return this.cacheAgeMs;
  }

  /** Turnos desde o último rebuild */
  get turnsSinceLastRebuild(): number {
    return this.turnsSinceRebuild;
  }

  /** Se o cache está ativo (não nulo) */
  get isCacheActive(): boolean {
    return this.cached !== null;
  }

  // ── Private ─────────────────────────────────────────────────────

  private shouldRebuild(): boolean {
    if (!this.cached) return true;    // null ou vazio → rebuild

    // Day rollover
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastDay) return true;

    return false;
  }

  /**
   * Constrói o bloco completo de memória.
   *
   * Ordem das seções (ADR-006):
   *   1. Scratchpad (até 2KB)
   *   2. Today daily log (até 3KB, tail)
   *   3. Persistent Memory (até 4KB, middle-truncated)
   *   4. Yesterday daily log (até 3KB, tail)
   */
  private async buildMemoryBlock(prompt: string): Promise<string> {
    const sections: Section[] = [];

    // ── Persistent Memory (busca híbrida) ──
    if (prompt) {
      try {
        const results = await this.searchFn(prompt);
        const memBlock = this.formatPersistentMemory(
          results,
          this.config.persistentMemCapBytes
        );
        if (memBlock) {
          sections.push({
            header: "## Persistent Memory",
            body: memBlock,
            priority: 0,
          });
        }
      } catch {
        // Search falhou, pula seção Persistent Memory
      }
    }

    // ── Seções customizadas (scratchpad, daily, yesterday) ──
    for (const [header, body] of this.customSections) {
      if (header.startsWith("__priority__")) continue;
      const priority = parseInt(
        this.customSections.get(`__priority__${header}`) ?? "10",
        10
      );
      sections.push({ header, body, priority });
    }

    // Ordena por prioridade
    sections.sort((a, b) => a.priority - b.priority);

    // Monta bloco
    let block = sections
      .map((s) => `${s.header}\n${s.body}`)
      .join("\n\n");

    // Cap total
    const totalCap = this.config.totalCapBytes;
    if (Buffer.byteLength(block) > totalCap) {
      // Prioriza: remove seções de menor prioridade até caber
      for (let i = sections.length - 1; i >= 0; i--) {
        if (Buffer.byteLength(block) <= totalCap) break;
        // Reconstrói sem esta seção
        const kept = sections.filter((_, idx) => idx !== i);
        block = kept
          .map((s) => `${s.header}\n${s.body}`)
          .join("\n\n");
      }

      // Se ainda exceder, trunca a última seção
      if (Buffer.byteLength(block) > totalCap) {
        block = this.truncateToBytes(block, totalCap);
      }
    }

    // Atualiza lastDay
    this.lastDay = new Date().toISOString().slice(0, 10);

    return block;
  }

  /**
   * Formata a seção Persistent Memory com bullet points ordenados.
   * Middle-truncation: se bloco excede o cap, remove bullets do meio,
   * preservando os de maior e menor relevância.
   */
  private formatPersistentMemory(
    results: RetrievalResult[],
    maxBytes: number
  ): string {
    if (results.length === 0) return "";

    const confThreshold = this.config.confidenceThreshold;
    const relevant = results.filter((r) => r.memory.confidence >= confThreshold);
    if (relevant.length === 0) return "";

    const header = ""; // header is added by buildMemoryBlock
    const maxBullets = this.config.maxBullets;
    const maxBulletLen = 200;

    // Formata bullets
    const bullets: string[] = [];
    for (let i = 0; i < Math.min(relevant.length, maxBullets); i++) {
      const mem = relevant[i].memory;
      const text =
        mem.text.length > maxBulletLen
          ? mem.text.slice(0, maxBulletLen - 1) + "…"
          : mem.text;
      bullets.push(`- [${mem.type}] ${text}`);
    }

    // Middle-truncation
    let body = header + bullets.join("\n");
    while (Buffer.byteLength(body) > maxBytes && bullets.length > 1) {
      // Remove o bullet do meio (mantém primeiro e último)
      const mid = Math.floor(bullets.length / 2);
      bullets.splice(mid, 1);
      body = header + bullets.join("\n");
    }

    // Fallback: trunca o último bullet
    if (Buffer.byteLength(body) > maxBytes && bullets.length > 0) {
      body = this.truncateToBytes(body, maxBytes);
    }

    return bullets.length > 0 ? body : "";
  }

  /**
   * Verifica se o prompt é trivial e não merece busca de memória.
   * Ex: "continue", "ok", "yes", prompts muito curtos.
   */
  private isTrivialPrompt(prompt: string): boolean {
    if (!prompt || prompt.trim().length < 5) return true;

    const trivialPatterns = [
      /^(continue|go on|proceed|next|ok|okay|yes|no|y|n)$/i,
      /^(sim|não|ok|continua|prossegue|vai|bora)$/i,
      /^(please\s+)?(continue|go\s+on|proceed)$/i,
    ];

    return trivialPatterns.some((p) => p.test(prompt.trim()));
  }

  /** Trunca string para caber em maxBytes (UTF-8 safe) */
  private truncateToBytes(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text) <= maxBytes) return text;

    // Binary search para achar o ponto de corte
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return text.slice(0, lo - 1) + "…";
  }
}
