/**
 * Hooks de captura — Handlers de eventos do pi que alimentam o buffer de observações.
 *
 * Cada hook extrai informações relevantes de um evento de lifecycle
 * e cria uma RawObservation para o pipeline de memória.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RawObservation, Memory } from "../types";
import type { IStorage } from "../storage/index";
import { ObservationBuffer } from "./buffer";
import { RegexExtractor } from "../extract/regex-extractor";
import { contentHash, compositeKey, consolidateN1 } from "../consolidate/dedup";
import { randomUUID } from "node:crypto";

// ── Constantes ─────────────────────────────────────────────────────────

/** Primeiros N bytes do output de tool armazenados no content_preview */
const CONTENT_PREVIEW_MAX_BYTES = 2048;

/** Primeiros N bytes do stderr armazenados no error_preview */
const ERROR_PREVIEW_MAX_BYTES = 500;

/** TTL padrão de observações: 7 dias em ms */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Tipos dos eventos do pi ────────────────────────────────────────────

interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: unknown;
  details?: Record<string, unknown>;
  isError: boolean;
  usage?: unknown;
}

interface BeforeAgentStartEvent {
  prompt: string;
  images?: unknown[];
  systemPrompt: string;
  systemPromptOptions: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Extrai file paths do input/output de uma tool call.
 * Detecta patterns comuns: path, filePath, paths, file, etc.
 */
function extractFilePaths(
  toolName: string,
  input: Record<string, unknown>,
  details?: Record<string, unknown>
): string[] {
  const paths = new Set<string>();

  // Input params comuns que contêm paths
  const pathKeys = ["path", "filePath", "file", "file_path", "paths", "files"];
  for (const key of pathKeys) {
    const val = input[key];
    if (typeof val === "string" && val.length > 0 && val.length < 4096) {
      paths.add(val);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.length > 0 && item.length < 4096) {
          paths.add(item);
        }
      }
    }
  }

  // Edit tool: pode ter múltiplos edits com path
  if (toolName === "edit" && input["edits"] && Array.isArray(input["edits"])) {
    for (const edit of input["edits"] as Array<Record<string, unknown>>) {
      if (typeof edit["path"] === "string") paths.add(edit["path"] as string);
    }
  }

  // Bash tool: pode conter paths no comando
  if (toolName === "bash" && typeof input["command"] === "string") {
    // Extração leve: procura por argumentos que parecem paths
    const cmd = input["command"] as string;
    const pathMatches = cmd.match(/(?:\s|^)(\/[^\s]+|[.]\/[^\s]+)/g);
    if (pathMatches) {
      for (const m of pathMatches) {
        const trimmed = m.trim();
        if (trimmed.length < 4096) paths.add(trimmed);
      }
    }
  }

  // Details: pode conter file list (ex: git status, grep results)
  if (details) {
    for (const key of ["files", "filePaths", "touchedFiles", "changedFiles"]) {
      const val = details[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string" && item.length > 0) paths.add(item);
        }
      }
    }
  }

  return [...paths];
}

/**
 * Extrai content preview do output de uma tool call.
 * Suporta formatos: string, array de content blocks, objeto com text.
 */
function extractContentPreview(content: unknown): string {
  if (typeof content === "string") {
    return content.slice(0, CONTENT_PREVIEW_MAX_BYTES);
  }

  if (Array.isArray(content)) {
    const textBlocks = content
      .filter(
        (block): block is { type: string; text?: string } =>
          typeof block === "object" && block !== null && "type" in block
      )
      .filter((block) => block.type === "text" || block.type === "error")
      .map((block) => block.text ?? "")
      .join("\n");

    return textBlocks.slice(0, CONTENT_PREVIEW_MAX_BYTES);
  }

  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (typeof obj["text"] === "string") {
      return (obj["text"] as string).slice(0, CONTENT_PREVIEW_MAX_BYTES);
    }
    if (typeof obj["output"] === "string") {
      return (obj["output"] as string).slice(0, CONTENT_PREVIEW_MAX_BYTES);
    }
  }

  return "";
}

/**
 * Extrai mensagem de erro do evento de tool_result.
 */
function extractErrorPreview(
  isError: boolean,
  content: unknown,
  details?: Record<string, unknown>
): string | null {
  if (!isError) return null;

  // Tenta extrair de details primeiro (pode conter stderr ou mensagem específica)
  if (details) {
    if (typeof details["stderr"] === "string" && details["stderr"].length > 0) {
      return (details["stderr"] as string).slice(0, ERROR_PREVIEW_MAX_BYTES);
    }
    if (typeof details["error"] === "string" && details["error"].length > 0) {
      return (details["error"] as string).slice(0, ERROR_PREVIEW_MAX_BYTES);
    }
    if (details["exitCode"] !== undefined && details["exitCode"] !== 0) {
      const preview = extractContentPreview(content);
      if (preview) return preview.slice(0, ERROR_PREVIEW_MAX_BYTES);
    }
  }

  // Fallback: preview do conteúdo de erro
  const preview = extractContentPreview(content);
  return preview ? preview.slice(0, ERROR_PREVIEW_MAX_BYTES) : null;
}

/**
 * Sanitiza input para armazenamento: remove dados muito grandes ou circulares.
 */
function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      sanitized[key] = value.length > 4096 ? value.slice(0, 4096) + "…" : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      sanitized[key] = value;
    } else if (typeof value === "object") {
      // Objetos e arrays: truncar se muito grandes
      try {
        const json = JSON.stringify(value);
        sanitized[key] = json.length > 4096 ? JSON.parse(json.slice(0, 4096)) : value;
      } catch {
        // Objeto circular ou não serializável: descarta
      }
    }
  }
  return sanitized;
}

// ── Factory Functions ──────────────────────────────────────────────────

export interface CaptureHooks {
  onToolResult: (
    event: ToolResultEvent,
    ctx: ExtensionContext
  ) => void;
  onBeforeAgentStart: (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ) => void;
  onTurnEnd: (
    event: { turnIndex: number; message: unknown; toolResults?: ToolResultEvent[] },
    ctx: ExtensionContext
  ) => void;
  onSessionShutdown: (
    event: { reason: string },
    ctx: ExtensionContext
  ) => void;
}

export interface CaptureHooksOptions {
  buffer: ObservationBuffer;
  projectId: string;
  sessionId: string;
  /** Extrator N2 opcional. Se não informado, N2 é skipado. */
  regexExtractor?: RegexExtractor;
  /** Storage para persistir memórias extraídas. Obrigatório se regexExtractor informado. */
  storage?: IStorage;
  /** Callback para reportar contagem de extrações N2 (stats). */
  onN2Extraction?: (count: number) => void;
}

/**
 * Cria handlers de captura vinculados a um buffer.
 */
export function createCaptureHooks(opts: CaptureHooksOptions): CaptureHooks {
  const { buffer, projectId, sessionId, regexExtractor, storage, onN2Extraction } = opts;
  return {
    /**
     * Captura tool_result: toda tool call completada vira uma RawObservation.
     * Se regexExtractor + storage disponíveis, roda N2 inline.
     */
    onToolResult(event, _ctx) {
      const now = Date.now();
      const sanitizedInput = sanitizeInput(event.input ?? {});

      const obs: RawObservation = {
        id: randomUUID(),
        session_id: sessionId,
        project_id: projectId,
        timestamp: now,
        type: "tool_result",
        tool_name: event.toolName,
        input_json: JSON.stringify(sanitizedInput),
        outcome: event.isError ? "error" : "success",
        content_preview: extractContentPreview(event.content),
        error_preview: extractErrorPreview(
          event.isError,
          event.content,
          event.details as Record<string, unknown> | undefined
        ),
        file_paths: extractFilePaths(
          event.toolName,
          sanitizedInput,
          event.details as Record<string, unknown> | undefined
        ),
        ttl: now + DEFAULT_TTL_MS,
        extracted: false,
      };

      // ── N2: Regex extraction (inline, <1ms) ──
      if (regexExtractor && storage) {
        try {
          const facts = regexExtractor.extract(obs);
          if (facts.length > 0) {
            obs.extracted = true;
            onN2Extraction?.(facts.length);

            // Converte cada ExtractedFact em Memory e persiste via pipeline N1
            for (const fact of facts) {
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
                project_id: projectId,
                content_hash: contentHash(fact.text),
              };

              // Pipeline N1: dedup → last-fact-wins
              const result = consolidateN1({
                memory,
                getByHash: (pid, hash) => storage.getMemoryByHash(pid, hash),
                getByKey: (key) =>
                  storage
                    .getMemoriesByProject(projectId)
                    .find(
                      (m) =>
                        !m.superseded_by &&
                        compositeKey(m.type, m.scope, m.tags) === key
                    ) ?? null,
              });

              switch (result.action) {
                case "create":
                  storage.insertMemory(result.memory);
                  break;
                case "reinforce":
                case "update":
                  storage.updateMemory(result.memory);
                  break;
                case "supersede":
                  if (result.supersededId) {
                    const oldMem = storage
                      .getMemoriesByProject(projectId)
                      .find((m) => m.id === result.supersededId);
                    if (oldMem) {
                      storage.updateMemory({
                        ...oldMem,
                        superseded_by: result.memory.id,
                      });
                    }
                  }
                  storage.insertMemory(result.memory);
                  break;
              }
            }
          }
        } catch {
          // N2 extraction nunca deve quebrar o agente
        }
      }

      buffer.enqueue(obs);
    },

    /**
     * Captura before_agent_start: registra intenção do usuário.
     */
    onBeforeAgentStart(event, _ctx) {
      const now = Date.now();

      const obs: RawObservation = {
        id: randomUUID(),
        session_id: sessionId,
        project_id: projectId,
        timestamp: now,
        type: "user_prompt",
        tool_name: null,
        input_json: JSON.stringify({ prompt: event.prompt }),
        outcome: "success",
        content_preview: event.prompt.slice(0, CONTENT_PREVIEW_MAX_BYTES),
        error_preview: null,
        file_paths: [],
        ttl: now + DEFAULT_TTL_MS,
        extracted: false,
      };

      buffer.enqueue(obs);
    },

    /**
     * Captura turn_end: usado como trigger para extração futura (N2/N3).
     * Na Fase 1, apenas registra que o turno terminou.
     */
    onTurnEnd(event, _ctx) {
      // Fase 1: placeholder. Fase 2: trigger para extração N2/N3.
      void event;
    },

    /**
     * Captura session_shutdown: flush final do buffer.
     */
    onSessionShutdown(_event, _ctx) {
      buffer.flush();
    },
  };
}
