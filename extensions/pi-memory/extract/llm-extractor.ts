/**
 * LlmExtractor — Extração via LLM que sugere páginas markdown.
 *
 * Disparado quando pendingObservations atinge batchSize (default: 50).
 * Sem timer — extração só ocorre com contexto suficiente.
 * SweepConsolidator processa leftover periodicamente.
 *
 * Prompt forense: só extrai fatos com evidência textual nas observações.
 */

import type { RawObservation, PageSuggestion, PageSuggestionResponse } from "../types";
import type { PageStore } from "../storage/page-store";
import type { IStorage } from "../storage/index";

// ── Config ─────────────────────────────────────────────────────────────

export interface LlmExtractorConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  batchSize: number;
  maxRetries: number;
  maxConsecutiveFailures: number;
  circuitCooldownMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

const DEFAULTS: Partial<LlmExtractorConfig> = {
  model: "openai/gpt-4o-mini",
  baseUrl: "https://openrouter.ai/api/v1",
  timeoutMs: 5_000,
  batchSize: 50,
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

  return `You are a forensic analyst reviewing a coding agent's interactions to build a project knowledge base.

Below are ${observations.length} interactions from a coding session. Extract structured knowledge about the project being worked on.

CRITICAL RULES:
1. Facts MUST be grounded in evidence from the interactions below. Cite interaction numbers.
2. DO NOT invent technologies, frameworks, or libraries not shown in the interactions.
3. Distinguish the PROJECT from the ANALYSIS SESSION:
   - PROJECT facts: language, framework, dependencies, architecture, domain concepts, code patterns, bugs
   - SESSION metadata (file extensions found, tools used to analyze) should NOT be extracted as pages
4. Synthesize from evidence: if composer.json shows "laravel/laravel" and directory has "app/Models", extract "Laravel project".
5. If you are unsure, OMIT the page. Empty response = { "pages": [] }.

Return a JSON object:
{
  "pages": [
    {
      "title": "Descriptive page title",
      "body": "## HH:MM Extraction title\n- Detailed fact with evidence from interaction #N.\n- Another relevant finding with context and specifics.\n- More details as needed — no word limit, only useful information.",
      "type": "decision | preference | lesson | pattern | fact",
      "scope": "project",
      "tags": ["tag1", "tag2"],
      "confidence": 0.0-1.0
    }
  ]
}

Body format requirements:
- ALWAYS start with "## HH:MM Extraction title" (use current time if unknown, e.g. "## 17:44 Project structure").
- Below the header, use bullet points (-) for each piece of information.
- Each bullet should be detailed and self-contained — future readers may only see this page.
- NO word limit. Write as much as needed to fully document each finding.
- Cite evidence: "(interação #N)" at the end of each bullet.

Extraction guide:
- DECISIONS: architecture choices, library selections (e.g. "chose Laravel as framework")
- PREFERENCES: coding style, conventions visible in code (scope: "global" if cross-project)
- LESSONS: bugs found, errors encountered, debugging insights
- PATTERNS: recurring code structures, naming conventions visible across files
- FACTS: dependencies (composer.json, package.json), PHP version, project structure, domain concepts
- IGNORE: file listings without content, successful install logs, trivial grep/ls results
- IGNORE: meta-information about the analysis session itself (tools used, file extensions scanned)
- confidence: 0.5-0.7. Multiple interactions confirming same fact = higher.
- Return ONLY the JSON object, no other text.`;
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
   * Enfileira observações para extração.
   * Dispara flush imediato quando atinge batchSize (sem timer).
   * Ignora observações já enfileiradas (dedup por id).
   */
  enqueue(observations: RawObservation[]): void {
    const pendingIds = new Set(this.pendingObservations.map((o) => o.id));
    const newObs = observations.filter((o) => !pendingIds.has(o.id));
    if (newObs.length === 0) return;
    this.pendingObservations.push(...newObs);

    // Dispara extração imediata se acumulou batchSize ou mais
    if (this.pendingObservations.length >= this.config.batchSize) {
      const batch = this.pendingObservations.splice(0, this.config.batchSize);
      // Fire-and-forget: não bloqueia o event loop
      this.extractBatch(batch);
    }
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
      }

      // Sempre marca como extraídas quando LLM respondeu com sucesso,
      // mesmo se parsing retornou vazio — evita loop infinito.
      this.markExtracted(observations);
      const processedIds = new Set(observations.map((o) => o.id));
      this.pendingObservations = this.pendingObservations.filter(
        (o) => !processedIds.has(o.id),
      );
      this.circuit.recordSuccess();
      this.consecutiveFailures = 0;
      this.onExtracted?.(suggestions.length);

      return suggestions;
    } catch (err) {
      this.circuit.recordFailure();
      this.consecutiveFailures++;
      return [];
    }
  }

  /** Cancela estado pendente. */
  shutdown(): void {
    this.pendingObservations = [];
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Chama LLM via API OpenAI-compatível.
   */

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
   * LLM extractions têm confidence cap 0.7 e nunca são pinned.
   */
  private async persistSuggestions(suggestions: PageSuggestion[]): Promise<void> {
    for (const suggestion of suggestions) {
      try {
        // Cap confidence: LLM extractions max 0.7. Apenas memory_write manual pode exceder.
        const capped = Math.min(suggestion.confidence ?? 0.5, 0.7);
        this.pageStore.writePage({
          title: suggestion.title,
          body: suggestion.body,
          type: suggestion.type,
          scope: suggestion.scope ?? "project",
          projectId: suggestion.scope === "global" ? null : this.projectId,
          tags: suggestion.tags,
          confidence: capped,
          pinned: false,  // nunca auto-pin extrações do LLM
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
