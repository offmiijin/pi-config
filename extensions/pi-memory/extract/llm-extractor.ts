/**
 * LlmExtractor — Extração via LLM que sugere páginas markdown.
 *
 * Roda fire-and-forget após turn_end de turnos "ricos" (bash/edit/write).
 * Acumula observações não extraídas em batch, chama LLM via OpenRouter,
 * recebe sugestões de páginas e persiste via PageStore.
 *
 * Prompt modificado para gerar páginas (title + body) em vez de fatos atômicos.
 */

import type { RawObservation, PageSuggestion, PageSuggestionResponse } from "../types";
import type { PageStore } from "../storage/page-store";
import type { IStorage } from "../storage/index";
import { randomUUID } from "node:crypto";

// ── Config ─────────────────────────────────────────────────────────────

export interface LlmExtractorConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  batchSize: number;
  maxWaitMs: number;
  maxRetries: number;
  maxConsecutiveFailures: number;
  circuitCooldownMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

const DEFAULTS: Partial<LlmExtractorConfig> = {
  model: "mistralai/mistral-nemo",
  baseUrl: "https://openrouter.ai/api/v1",
  timeoutMs: 5_000,
  batchSize: 10,
  maxWaitMs: 30_000,
  maxRetries: 3,
  maxConsecutiveFailures: 5,
  circuitCooldownMs: 300_000,
  baseBackoffMs: 30_000,
  maxBackoffMs: 300_000,
};

// ── Prompt template ────────────────────────────────────────────────────

function buildExtractionPrompt(observations: RawObservation[]): string {
  const interactions = observations
    .map((obs, i) => {
      const parts: string[] = [];
      parts.push(`### Interaction ${i + 1}`);

      if (obs.type === "user_prompt") {
        parts.push(`Type: User prompt`);
        if (obs.content_preview) {
          parts.push(`Content: ${obs.content_preview.slice(0, 500)}`);
        }
      } else {
        parts.push(`Type: Tool result`);
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
      }
      return parts.join("\n");
    })
    .join("\n\n");

  return `You are extracting structured knowledge from a coding agent's interactions and organizing it into a wiki.

Below are ${observations.length} interactions. They may be user prompts or tool results.

Extract key information as WIKI PAGES. Each page should be a cohesive document covering one topic.

Return a JSON object:
{
  "pages": [
    {
      "title": "Descriptive page title (will be used as filename)",
      "body": "Full markdown content. Use ## headings for sections. Be concise but complete.",
      "type": "decision | preference | lesson | pattern | fact",
      "scope": "project",     // "project" or "global" (default: project)
      "tags": ["tag1", "tag2"],
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- IGNORE trivial output: file listings, successful npm install, standard build output, successful git commits
- IGNORE stack traces longer than 50 lines (summarize the error instead)
- DECISIONS: architecture choices, library selections, design patterns adopted
- PREFERENCES: tool choices, coding style, conventions (scope: "global" if cross-project)
- LESSONS: bugs found, debugging insights, "don't do X" knowledge
- PATTERNS: recurring code structures, naming conventions, error handling patterns
- FACTS: objective project characteristics, dependencies, deployment info
- Each page title must be clear and specific. "Bug fix" is NOT acceptable.
  "Auth timeout was 100ms instead of 5000ms" IS acceptable.
- body can contain markdown: headings, lists, code blocks, etc.
- confidence: 0.9+ for explicit statements, 0.5-0.7 for inferred. Max 1.0.
- Return ONLY the JSON object, no other text. Do NOT wrap in markdown code blocks.`;
}

// ── Response parser ────────────────────────────────────────────────────

function parseLlmResponse(raw: string): PageSuggestion[] {
  const trimmed = raw.trim();

  // Tenta parse direto como PageSuggestionResponse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.pages && Array.isArray(parsed.pages)) {
      return validateSuggestions(parsed.pages);
    }
    // Se veio array direto (compatibilidade)
    if (Array.isArray(parsed)) {
      return validateSuggestions(parsed);
    }
  } catch {
    // continua
  }

  // Tenta extrair de markdown code block
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try {
      const parsed = JSON.parse(codeBlock[1].trim());
      if (parsed.pages && Array.isArray(parsed.pages)) {
        return validateSuggestions(parsed.pages);
      }
      if (Array.isArray(parsed)) {
        return validateSuggestions(parsed);
      }
    } catch {
      // continua
    }
  }

  // Array inline
  const arrayMatch = trimmed.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) return validateSuggestions(parsed);
    } catch {
      // continua
    }
  }

  // Objeto inline
  const objMatch = trimmed.match(/\{\s*"pages"\s*:[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed.pages && Array.isArray(parsed.pages)) {
        return validateSuggestions(parsed.pages);
      }
    } catch {
      // continua
    }
  }

  return [];
}

/** Valida e normaliza sugestões do LLM. */
function validateSuggestions(raw: Record<string, unknown>[]): PageSuggestion[] {
  const valid: PageSuggestion[] = [];
  const validTypes = new Set(["decision", "preference", "lesson", "pattern", "fact"]);
  const validScopes = new Set(["project", "global"]);

  for (const item of raw) {
    if (!item["title"] || typeof item["title"] !== "string") continue;
    if (!item["body"] || typeof item["body"] !== "string") continue;

    const type = item["type"] as string;
    if (!type || !validTypes.has(type)) continue;

    const scope = item["scope"] as string;
    if (scope && !validScopes.has(scope)) continue;

    valid.push({
      title: item["title"] as string,
      body: item["body"] as string,
      type: type as PageSuggestion["type"],
      scope: (scope as PageSuggestion["scope"]) ?? "project",
      tags: Array.isArray(item["tags"]) ? (item["tags"] as string[]) : [],
      confidence: typeof item["confidence"] === "number" ? Math.min(1, Math.max(0, item["confidence"])) : 0.5,
    });
  }

  return valid;
}

// ── Circuit breaker ────────────────────────────────────────────────────

class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold: number, cooldownMs: number) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  get isOpen(): boolean {
    if (this.failures >= this.threshold) {
      if (Date.now() - this.lastFailure > this.cooldownMs) {
        this.failures = 0; // semi-open
        return false;
      }
      return true;
    }
    return false;
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
  }

  recordSuccess(): void {
    this.failures = 0;
  }
}

// ── LlmExtractor ───────────────────────────────────────────────────────

export class LlmExtractor {
  private readonly config: LlmExtractorConfig;
  private readonly pageStore: PageStore;
  private readonly storage: IStorage | null;
  private readonly projectId: string;
  private readonly onExtracted?: (count: number) => void;

  private pendingObservations: RawObservation[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private circuit: CircuitBreaker;
  private consecutiveFailures = 0;

  constructor(
    pageStore: PageStore,
    projectId: string,
    config: Partial<LlmExtractorConfig> = {},
    onExtracted?: (count: number) => void,
    storage?: IStorage,
  ) {
    this.pageStore = pageStore;
    this.storage = storage ?? null;
    this.projectId = projectId;
    this.config = { ...DEFAULTS, ...config } as LlmExtractorConfig;
    this.onExtracted = onExtracted;
    this.circuit = new CircuitBreaker(
      this.config.maxConsecutiveFailures,
      this.config.circuitCooldownMs,
    );
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Enfileira observações para extração no próximo batch.
   */
  enqueue(observations: RawObservation[]): void {
    this.pendingObservations.push(...observations);
    this.scheduleBatch();
  }

  /**
   * Extrai um batch específico (chamado pelo SweepConsolidator).
   */
  async extractBatch(observations: RawObservation[]): Promise<PageSuggestion[]> {
    if (observations.length === 0) return [];
    if (this.circuit.isOpen) return [];

    try {
      const prompt = buildExtractionPrompt(observations);
      const response = await this.callLlm(prompt);
      const suggestions = parseLlmResponse(response);

      if (suggestions.length > 0) {
        await this.persistSuggestions(suggestions);
        this.markExtracted(observations);
        this.circuit.recordSuccess();
        this.consecutiveFailures = 0;
        this.onExtracted?.(suggestions.length);
      }

      return suggestions;
    } catch (err) {
      this.circuit.recordFailure();
      this.consecutiveFailures++;
      return [];
    }
  }

  /** Força flush de observações pendentes. */
  async flush(): Promise<void> {
    if (this.pendingObservations.length === 0) return;
    const batch = this.pendingObservations.splice(0, this.config.batchSize);
    await this.extractBatch(batch);
  }

  /** Cancela timer e reseta estado. */
  shutdown(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingObservations = [];
  }

  // ── Private ──────────────────────────────────────────────────────

  private scheduleBatch(): void {
    if (this.batchTimer) return;

    this.batchTimer = setTimeout(async () => {
      this.batchTimer = null;
      await this.flush();
    }, this.config.maxWaitMs);
  }

  /**
   * Chama LLM via API OpenAI-compatível.
   */
  private async callLlm(prompt: string): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.config.model,
      messages: [
        {
          role: "system",
          content: "You are a knowledge extraction assistant. Output JSON only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices?.[0]?.message?.content ?? "";
  }

  /**
   * Persiste sugestões de página via PageStore.
   * Se confidence > 0.8: active. Senão: draft.
   */
  private async persistSuggestions(suggestions: PageSuggestion[]): Promise<void> {
    for (const suggestion of suggestions) {
      try {
        this.pageStore.writePage({
          title: suggestion.title,
          body: suggestion.body,
          type: suggestion.type,
          scope: suggestion.scope ?? "project",
          projectId: suggestion.scope === "global" ? null : this.projectId,
          tags: suggestion.tags,
          confidence: suggestion.confidence,
          pinned: suggestion.confidence !== undefined && suggestion.confidence >= 0.8,
        });
      } catch {
        // Falha numa página não quebra o batch
      }
    }
  }

  /**
   * Marca observações como extraídas (para não reprocessar).
   */
  private markExtracted(observations: RawObservation[]): void {
    if (!this.storage) return;
    const ids = observations.map((o) => o.id);
    try {
      this.storage.markExtracted(ids);
    } catch {
      // Best-effort
    }
  }
}
