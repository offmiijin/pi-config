/**
 * LlmExtractor — N3: Extração em background via LLM barato.
 *
 * Roda fire-and-forget após turn_end de turnos "ricos" (bash/edit/write).
 * Acumula observações não extraídas em batch, chama LLM via OpenRouter,
 * extrai fatos atômicos e persiste via pipeline N1 (consolidate).
 *
 * ADR-002: Nível 3 — LLM barato (background, ~$0.0002/extração).
 * Default model: mistralai/mistral-nemo via OpenRouter.
 */

import type { RawObservation, ExtractedFact, Memory } from "../types";
import type { IStorage } from "../storage/index";
import { contentHash, compositeKey, consolidateN1 } from "../consolidate/dedup";
import { randomUUID } from "node:crypto";

// ── Config ─────────────────────────────────────────────────────────────

export interface LlmExtractorConfig {
  /** API key (LLM_API_KEY env var). Provider OpenAI-compatível. */
  apiKey: string;
  /** Modelo LLM. Default: mistralai/mistral-nemo */
  model: string;
  /** Base URL da API OpenAI-compatível. */
  baseUrl: string;
  /** Timeout da chamada HTTP em ms. Default: 5000 */
  timeoutMs: number;
  /** Tamanho do batch de observações. Default: 10 */
  batchSize: number;
  /** Tempo máximo de espera antes de disparar batch parcial. Default: 30000 */
  maxWaitMs: number;
  /** Máximo de retentativas por observação. Default: 3 */
  maxRetries: number;
  /** Pipeline N1 dedup habilitado? Default: true */
  dedupEnabled: boolean;
}

const DEFAULTS: Partial<LlmExtractorConfig> = {
  model: "mistralai/mistral-nemo",
  baseUrl: "https://openrouter.ai/api/v1",
  timeoutMs: 5_000,
  batchSize: 10,
  maxWaitMs: 30_000,
  maxRetries: 3,
  dedupEnabled: true,
};

// ── Prompt template ────────────────────────────────────────────────────

function buildExtractionPrompt(observations: RawObservation[]): string {
  const interactions = observations
    .map((obs, i) => {
      const parts: string[] = [];
      parts.push(`### Interaction ${i + 1}`);
      parts.push(`Tool: ${obs.tool_name ?? "unknown"}`);
      parts.push(`Outcome: ${obs.outcome}`);
      if (obs.content_preview) {
        parts.push(`Output: ${obs.content_preview.slice(0, 500)}`);
      }
      if (obs.error_preview) {
        parts.push(`Error: ${obs.error_preview.slice(0, 300)}`);
      }
      if (obs.file_paths.length > 0) {
        parts.push(`Files: ${obs.file_paths.join(", ")}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");

  return `You are extracting structured knowledge from a coding agent's interactions.

Below are ${observations.length} interactions between a coding agent and its tools.
Extract atomic, self-contained facts. Each fact must be understandable without context.

${interactions}

Return a JSON array of facts:
[
  {
    "text": "self-contained fact statement",
    "type": "fact | preference | decision | lesson | pattern",
    "confidence": 0.0-1.0,
    "tags": ["#tag1", "#tag2"]
  }
]

Rules:
- IGNORE trivial output: file listings, successful npm install, standard build output
- IGNORE stack traces longer than 50 lines (summarize instead)
- PREFERENCES: "uses pnpm", "prefers functional style", "always writes tests"
- DECISIONS: "chose hexagonal architecture", "decided to use PostgreSQL"
- LESSONS: "test X fails with Node 22", "don't use feature Y because of bug Z"
- FACTS: "project has 3 services", "deploy uses ArgoCD"
- PATTERNS: "all routes follow /api/v1/ prefix", "error handling uses Either monad"
- Each fact MUST be self-contained. "Fixed the bug" is NOT acceptable.
  "Fixed bug in auth.spec.ts where login timeout was set to 100ms instead of 5000ms" IS acceptable.
- confidence: 0.9+ for explicit statements, 0.5-0.7 for inferred facts. Max 1.0.
- Return ONLY the JSON array, no other text. Do NOT wrap in markdown code blocks unless necessary.`;
}

// ── Response parser ────────────────────────────────────────────────────

function parseLlmResponse(raw: string): ExtractedFact[] {
  const trimmed = raw.trim();

  // Tenta parse direto
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return validateFacts(parsed);
  } catch {
    // continua
  }

  // Tenta extrair de markdown code block (```json ... ```)
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try {
      const parsed = JSON.parse(codeBlock[1].trim());
      if (Array.isArray(parsed)) return validateFacts(parsed);
    } catch {
      // continua
    }
  }

  // Tenta extrair array JSON inline
  const arrayMatch = trimmed.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return validateFacts(parsed);
    } catch {
      // continua
    }
  }

  return [];
}

/** Valida e normaliza fatos extraídos, descartando inválidos */
function validateFacts(raw: unknown[]): ExtractedFact[] {
  const valid: ExtractedFact[] = [];
  const validTypes = new Set(["fact", "preference", "decision", "lesson", "pattern"]);
  const validScopes = new Set(["project", "user", "session", "global"]);

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    if (typeof f["text"] !== "string" || f["text"].trim().length === 0) continue;

    const type = typeof f["type"] === "string" ? f["type"] : "fact";
    if (!validTypes.has(type)) continue;

    const scope = typeof f["scope"] === "string" && validScopes.has(f["scope"])
      ? f["scope"]
      : "project";

    const confidence = typeof f["confidence"] === "number"
      ? Math.max(0, Math.min(1, f["confidence"]))
      : 0.5;

    const tags: string[] = [];
    if (Array.isArray(f["tags"])) {
      for (const t of f["tags"]) {
        if (typeof t === "string" && t.trim().length > 0) {
          tags.push(t.startsWith("#") ? t : `#${t}`);
        }
      }
    }

    valid.push({
      text: (f["text"] as string).trim(),
      type: type as ExtractedFact["type"],
      scope: scope as ExtractedFact["scope"],
      tags,
      confidence,
      source_observation_ids: [],
    });
  }

  return valid;
}

// ── LlmExtractor ───────────────────────────────────────────────────────

export class LlmExtractor {
  private pendingObs: RawObservation[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private retryCounts = new Map<string, number>();
  private readonly config: LlmExtractorConfig;
  private readonly storage: IStorage;
  private readonly projectId: string;
  private readonly onExtraction?: (count: number) => void;

  constructor(
    storage: IStorage,
    projectId: string,
    overrides: Partial<LlmExtractorConfig> = {},
    onExtraction?: (count: number) => void,
  ) {
    this.storage = storage;
    this.projectId = projectId;
    this.config = { ...DEFAULTS, ...overrides } as LlmExtractorConfig;
    this.onExtraction = onExtraction;
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Enfileira observações para extração N3.
   * Filtra: apenas não extraídas e com conteúdo suficiente (>50 chars).
   * Dispara batch se atingiu batchSize, senão agenda timer.
   */
  enqueue(observations: RawObservation[]): void {
    if (!this.config.apiKey) return;

    const candidates = this.filterCandidates(observations);
    if (candidates.length === 0) return;
    this.pendingObs.push(...candidates);

    if (this.pendingObs.length >= this.config.batchSize) {
      this.extract();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.extract(), this.config.maxWaitMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  /**
   * Extração direta de um batch (usado pelo SweepConsolidator).
   * Fire-and-forget: não espera resultado.
   *
   * @param observations - Observações a extrair (já devem estar filtradas)
   */
  extractBatch(observations: RawObservation[]): void {
    if (!this.config.apiKey) return;
    if (observations.length === 0) return;
    // Trava de concorrência: se já tem extração rodando, não empilha outra
    if (this.busy) return;
    this.extract(observations);
  }

  /** Para timer e dispara extração do que estiver pendente. */
  shutdown(): void {
    this.clearTimer();
    if (this.pendingObs.length > 0) {
      this.extract();
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  private filterCandidates(observations: RawObservation[]): RawObservation[] {
    return observations.filter(
      (o) =>
        !o.extracted &&
        o.content_preview &&
        o.content_preview.length > 50,
    );
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executa extração LLM para um batch de observações.
   * Se `forcedBatch` for fornecido, extrai diretamente dele (bypass enqueue).
   * Caso contrário, consome do `pendingObs` interno.
   */
  private async extract(forcedBatch?: RawObservation[]): Promise<void> {
    const isForced = forcedBatch !== undefined;
    const batch =
      forcedBatch ??
      this.pendingObs.splice(0, Math.min(this.pendingObs.length, this.config.batchSize));

    if (batch.length === 0) return;

    // Verifica busy e seta (ambos modos)
    if (this.busy) return;
    this.busy = true;
    if (!isForced) {
      this.clearTimer();
    }

    try {
      const prompt = buildExtractionPrompt(batch);
      const rawResponse = await this.callLlm(prompt);
      const facts = parseLlmResponse(rawResponse);

      if (facts.length > 0) {
        const now = Date.now();
        for (const fact of facts) {
          // Preenche source_observation_ids se vazio
          if (fact.source_observation_ids.length === 0) {
            fact.source_observation_ids = batch.map((o) => o.id);
          }

          const memory: Memory = {
            id: randomUUID(),
            text: fact.text,
            embedding: null,
            type: fact.type,
            scope: fact.scope,
            tags: fact.tags,
            confidence: fact.confidence,
            timestamp: now,
            last_accessed: now,
            access_count: 1,
            source_ids: fact.source_observation_ids,
            superseded_by: null,
            pinned: false,
            project_id: this.projectId,
            content_hash: contentHash(fact.text),
          };

          const result = consolidateN1({
            memory,
            dedupEnabled: this.config.dedupEnabled,
            getByHash: (pid, hash) => this.storage.getMemoryByHash(pid, hash),
            getByKey: (key) =>
              this.storage
                .getMemoriesByProject(this.projectId)
                .find(
                  (m) =>
                    !m.superseded_by &&
                    compositeKey(m.type, m.scope, m.tags) === key,
                ) ?? null,
          });

          switch (result.action) {
            case "create":
              this.storage.insertMemory(result.memory);
              break;
            case "reinforce":
            case "update":
              this.storage.updateMemory(result.memory);
              break;
            case "supersede":
              if (result.supersededId) {
                const old = this.storage
                  .getMemoriesByProject(this.projectId)
                  .find((m) => m.id === result.supersededId);
                if (old) {
                  this.storage.updateMemory({
                    ...old,
                    superseded_by: result.memory.id,
                  });
                }
              }
              this.storage.insertMemory(result.memory);
              break;
          }
        }

        this.onExtraction?.(facts.length);
      }

      // Marca observações como extraídas
      this.storage.markExtracted(batch.map((o) => o.id));
      this.retryCounts.clear();
    } catch {
      // Retry logic: re-enfileira observações com retry count < max
      for (const obs of batch) {
        const retries = this.retryCounts.get(obs.id) ?? 0;
        if (retries < this.config.maxRetries) {
          this.retryCounts.set(obs.id, retries + 1);
          this.pendingObs.push(obs);
        } else {
          // Desiste: marca como extraída para não bloquear sweep futuro
          try {
            this.storage.markExtracted([obs.id]);
          } catch {
            // best-effort
          }
          this.retryCounts.delete(obs.id);
        }
      }
    } finally {
      this.busy = false;
      // Timer de re-agendamento só no modo enqueue
      if (!isForced && this.pendingObs.length > 0 && !this.timer) {
        this.timer = setTimeout(() => this.extract(), this.config.maxWaitMs);
        if (this.timer.unref) this.timer.unref();
      }
    }
  }

  private async callLlm(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const resp = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 1000,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(
          `LLM API error ${resp.status}${body ? ": " + body.slice(0, 200) : ""}`,
        );
      }

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }
}
