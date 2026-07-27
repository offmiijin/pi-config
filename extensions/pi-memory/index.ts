/**
 * pi-memory — Extensão de memória persistente para o pi coding agent.
 *
 * Pipeline: CAPTURE → EXTRACT → STORE → CONSOLIDATE → RETRIEVE → INJECT
 *
 * Fase 1 (MVP): Captura, Storage SQLite+JSON, Consolidação N1 (dedup),
 *               Retrieval BM25, Injeção simples, Tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import type { PiMemoryConfig, MemoryStats } from "./types";

// ── Estado interno ─────────────────────────────────────────────────────
let config: PiMemoryConfig;
let stats: MemoryStats;

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
  // ── Carregar configuração ──
  config = loadConfig(pi.projectDir);

  if (config.disabled) {
    return;
  }

  stats = resetStats();

  // ── Lifecycle: session_start ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // TODO 1.2: init storage (sqlite + json)
    // TODO 3.1: rebuild ram index

    if (ctx?.hasUI) {
      ctx.ui.notify("🧠 pi-memory carregado", "info");
    }
  });

  // ── Lifecycle: tool_result ────────────────────────────────────────
  pi.on("tool_result", async (event, _ctx) => {
    // TODO 1.3: criar RawObservation, enfileirar no buffer
    stats.operations.captures++;
  });

  // ── Lifecycle: before_agent_start ─────────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    // TODO 1.6: buscar memórias, injetar bloco no system prompt
    stats.operations.injections++;
  });

  // ── Lifecycle: session_shutdown ───────────────────────────────────
  pi.on("session_shutdown", async (_event, _ctx) => {
    // TODO 1.3: flush buffer
    // TODO 1.2: fechar storage
  });

  // ── Tools ─────────────────────────────────────────────────────────
  // TODO 1.7: memory_search, memory_write, memory_status
}
