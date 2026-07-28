/**
 * JsonStore — Camada cold de storage: JSON em disco.
 *
 * Persiste memórias e observações como arquivos JSON legíveis.
 * Usado para auditoria, debug, backup e rebuild do índice.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Memory, RawObservation } from "../types";

export class JsonStore {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  private get memoriesPath(): string {
    return path.join(this.dataDir, "memories.json");
  }

  private get observationsPath(): string {
    return path.join(this.dataDir, "observations.json");
  }

  // ── Memórias ──────────────────────────────────────────────────────

  writeMemories(memories: Memory[]): void {
    const serialized = memories.map((m) => ({
      ...m,
      embedding: m.embedding ? Array.from(m.embedding) : null,
    }));
    this.atomicWrite(this.memoriesPath, JSON.stringify(serialized, null, 2));
  }

  readMemories(): Memory[] {
    if (!fs.existsSync(this.memoriesPath)) return [];

    const raw = fs.readFileSync(this.memoriesPath, "utf-8");
    if (!raw.trim()) return [];

    const items = JSON.parse(raw) as Array<Record<string, unknown>>;
    return items.map((item) => ({
      ...item,
      embedding: item["embedding"]
        ? new Float32Array(item["embedding"] as number[])
        : null,
    })) as unknown as Memory[];
  }

  // ── Observações ────────────────────────────────────────────────────

  writeObservations(observations: RawObservation[]): void {
    this.atomicWrite(this.observationsPath, JSON.stringify(observations, null, 2));
  }

  readObservations(): RawObservation[] {
    if (!fs.existsSync(this.observationsPath)) return [];

    const raw = fs.readFileSync(this.observationsPath, "utf-8");
    if (!raw.trim()) return [];

    return JSON.parse(raw) as RawObservation[];
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private atomicWrite(filePath: string, content: string): void {
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  }
}
