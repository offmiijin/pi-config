/**
 * pi-memory — Extensão de memória persistente para o pi coding agent.
 *
 * Pipeline: CAPTURE → EXTRACT → STORE → CONSOLIDATE → RETRIEVE → INJECT
 *
 * Fase 1 (MVP): Captura, Storage SQLite+JSON, Consolidação N1 (dedup),
 *               Retrieval BM25, Injeção simples, Tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import type { PiMemoryConfig, MemoryStats } from "./types";
import { UnifiedStore } from "./storage/unified-store";
import type { IStorage } from "./storage/index";
import { ObservationBuffer } from "./capture/buffer";
import { createCaptureHooks } from "./capture/hooks";
import { Bm25Retriever } from "./retrieve/bm25";
import { createInjectHandler } from "./inject/context-builder";
import { createMemorySearchTool } from "./tools/memory-search";
import { createMemoryWriteTool } from "./tools/memory-write";
import { createMemoryStatusTool } from "./tools/memory-status";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ── Estado interno ─────────────────────────────────────────────────────
let config: PiMemoryConfig;
let stats: MemoryStats;
let storage: IStorage | null = null;
let buffer: ObservationBuffer | null = null;
let retriever: Bm25Retriever | null = null;
let sessionId: string | null = null;

function resetStats(): MemoryStats {
  return {
    total_memories: 0,
    total_observations: 0,
    pending_extraction: 0,
    expired_observations: 0,
    by_type: { preference: 0, decision: 0, lesson: 0, fact: 0, pattern: 0 },
    by_scope: { project: 0, user: 0, session: 0, global: 0 },
    avg_confidence: 0,
    pinned_count: 0,
    operations: {
      captures: 0,
      extractions_n2: 0,
      extractions_n3: 0,
      consolidations_n2: 0,
      retrievals: 0,
      injections: 0,
    },
    kv_cache_stable: true,
    kv_cache_age_ms: 0,
    kv_cache_turns_since_rebuild: 0,
    gateway_decisions: { KNOWN: 0, PRIOR: 0, NONE: 0 },
  };
}

export default function (pi: ExtensionAPI) {
  // ── Flag ──────────────────────────────────────────────────────────
  pi.registerFlag?.("no-memory", {
    description: "Disable persistent memory for this session",
  });

  // ── Carregar configuração ──
  config = loadConfig(pi.projectDir);

  if (config.disabled) {
    return;
  }

  stats = resetStats();

  // ── Lifecycle: session_start ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Já inicializado? (ex: reload)
    if (storage) return;

    const projectId = hashProjectId(pi.projectDir ?? "default");
    sessionId = randomUUID();

    // Cria diretório de dados
    const dbPath = path.join(config.data_dir, `${projectId}.db`);
    const jsonDir = path.join(config.data_dir, "data");

    try {
      // Inicializa storage
      storage = new UnifiedStore(dbPath, jsonDir);
      storage.open();

      // Inicializa buffer
      buffer = new ObservationBuffer(
        config.buffer_max_size,
        config.buffer_flush_interval_ms
      );
      buffer.attach(storage);

      // Inicializa retriever
      retriever = new Bm25Retriever(storage);

      if (ctx?.hasUI) {
        const memCount = storage.countMemories();
        ctx.ui.notify(
          `🧠 pi-memory carregado (${memCount} memórias)`,
          "info"
        );
      }
    } catch (err) {
      // Falha não deve quebrar o agente
      if (ctx?.hasUI) {
        ctx.ui.notify(
          `⚠️ pi-memory: falha ao inicializar storage: ${(err as Error).message}`,
          "error"
        );
      }
      storage = null;
      buffer = null;
      retriever = null;
    }
  });

  // ── Lifecycle: tool_result ────────────────────────────────────────
  pi.on("tool_result", async (event, _ctx) => {
    if (!buffer || !sessionId) return;

    const hooks = createCaptureHooks(
      buffer,
      hashProjectId(pi.projectDir ?? "default"),
      sessionId
    );

    hooks.onToolResult(
      event as Parameters<typeof hooks.onToolResult>[0],
      _ctx
    );

    stats.operations.captures++;
  });

  // ── Lifecycle: before_agent_start ─────────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!retriever || !storage) return;

    const projectId = hashProjectId(pi.projectDir ?? "default");

    const injectHandler = createInjectHandler({
      retriever,
      projectId,
      maxBytes: config.max_injection_bytes,
    });

    const result = await injectHandler(
      event as Parameters<typeof injectHandler>[0]
    );

    stats.operations.injections++;

    return result;
  });

  // ── Lifecycle: session_shutdown ───────────────────────────────────
  pi.on("session_shutdown", async (_event, _ctx) => {
    // Flush buffer
    if (buffer) {
      buffer.flush();
      buffer.detach();
      buffer = null;
    }

    // Fecha storage
    if (storage) {
      try {
        storage.syncToJson();
      } catch {
        // Cold sync é best-effort
      }
      storage.close();
      storage = null;
    }

    retriever = null;
    sessionId = null;
  });

  // ── Tools ─────────────────────────────────────────────────────────
  const projectId = hashProjectId(pi.projectDir ?? "default");

  // Tools recebem storage/retriever via closure.
  // Se storage ainda não foi inicializado (antes de session_start),
  // a tool falhará graciosamente (retorna erro).
  pi.registerTool({
    ...createMemorySearchTool(
      // Wrapper lazy: se retriever null, retorna erro
      {
        search(
          query: string,
          pid: string,
          topK?: number
        ) {
          if (!retriever) {
            throw new Error(
              "Memory system not initialized. Wait for session_start."
            );
          }
          return retriever.search(query, pid, topK);
        },
      } as Bm25Retriever,
      projectId
    ),
  });

  pi.registerTool({
    ...createMemoryWriteTool(
      // Wrapper lazy para storage
      {
        getMemoryByHash(pid: string, hash: string) {
          if (!storage) throw new Error("Memory system not initialized.");
          return storage.getMemoryByHash(pid, hash);
        },
        getMemoriesByProject(pid: string) {
          if (!storage) throw new Error("Memory system not initialized.");
          return storage.getMemoriesByProject(pid);
        },
        updateMemory(mem: Parameters<IStorage["updateMemory"]>[0]) {
          if (!storage) throw new Error("Memory system not initialized.");
          return storage.updateMemory(mem);
        },
        insertMemory(mem: Parameters<IStorage["insertMemory"]>[0]) {
          if (!storage) throw new Error("Memory system not initialized.");
          return storage.insertMemory(mem);
        },
      } as IStorage,
      projectId,
      () => sessionId ?? "unknown"
    ),
  });

  pi.registerTool({
    ...createMemoryStatusTool(
      // Wrapper lazy para storage
      {
        countMemories() {
          if (!storage) return 0;
          return storage.countMemories();
        },
        countObservations() {
          if (!storage) return 0;
          return storage.countObservations();
        },
        countPendingExtraction() {
          if (!storage) return 0;
          return storage.countPendingExtraction();
        },
        getMemoriesByProject(pid: string) {
          if (!storage) return [];
          return storage.getMemoriesByProject(pid);
        },
      } as IStorage,
      projectId
    ),
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Gera um ID de projeto curto (8 chars hex) a partir do diretório.
 * Estável: mesmo diretório = mesmo ID.
 */
function hashProjectId(projectDir: string): string {
  if (!projectDir || projectDir === "default") return "default";
  // Hash simples: soma de charCodes mod 16^8
  let hash = 0;
  for (let i = 0; i < projectDir.length; i++) {
    hash = (hash * 31 + projectDir.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}
