/**
 * pi-memory — Extensão de memória persistente para o pi coding agent.
 *
 * Pipeline: CAPTURE → EXTRACT → STORE → CONSOLIDATE → RETRIEVE → INJECT
 *
 * Markdown wiki como fonte da verdade, SQLite como índice derivado.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, extraConfigPath } from "./config";
import type { PiMemoryConfig, MemoryStats, RetrievalResult } from "./types";
import { SqliteStore } from "./storage/sqlite-store";
import type { IStorage } from "./storage/index";
import { ObservationBuffer } from "./capture/buffer";
import { createCaptureHooks } from "./capture/hooks";

import { LlmExtractor } from "./extract/llm-extractor";
import type { LlmExtractorConfig } from "./extract/llm-extractor";
import { Bm25Retriever } from "./retrieve/bm25";
import { EmbeddingService } from "./utils/embedding";
import { VectorRetriever } from "./retrieve/vector";

import { HybridRetriever } from "./retrieve/index";
import { CacheStableInjector } from "./inject/snapshot";
import { createMemorySearchTool } from "./tools/memory-search";
import { createMemoryWriteTool } from "./tools/memory-write";
import { createMemoryStatusTool } from "./tools/memory-status";
import { createMemoryRestoreTool } from "./tools/memory-restore";
import { GitLayer } from "./wiki/git-layer";
import { PageStore } from "./storage/page-store";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// ── Estado interno ─────────────────────────────────────────────────────
let config: PiMemoryConfig;
let stats: MemoryStats;
let storage: IStorage | null = null;
let buffer: ObservationBuffer | null = null;
let retriever: Bm25Retriever | null = null;
let llmExtractor: LlmExtractor | null = null;
let embeddingService: EmbeddingService | null = null;
let vectorRetriever: VectorRetriever | null = null;
let hybridRetriever: HybridRetriever | null = null;
let cacheStableInjector: CacheStableInjector | null = null;
let pageStore: PageStore | null = null;
let gitLayer: GitLayer | null = null;
let sessionId: string | null = null;

function resetStats(): MemoryStats {
  return {
    total_pages: 0,
    total_observations: 0,
    pending_extraction: 0,
    expired_observations: 0,
    by_type: { preference: 0, decision: 0, lesson: 0, fact: 0, pattern: 0, session: 0 },
    by_scope: { project: 0, global: 0 },
    avg_confidence: 0,
    pinned_count: 0,
    operations: {
      captures: 0,
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
  loadEnvFile();
  checkRuntime();

  pi.registerFlag?.("no-memory", {
    description: "Disable persistent memory for this session",
    type: "boolean",
    default: false,
  });

  config = loadConfig(pi.projectDir);

  if (pi.getFlag?.("no-memory")) {
    config.disabled = true;
  }

  if (config.disabled) {
    return;
  }

  stats = resetStats();

  // ── Lifecycle: session_start ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(pi.projectDir);

    if (config.disabled) return;
    if (storage) return;

    const projectId = hashProjectId(pi.projectDir ?? "default");
    sessionId = randomUUID();
    const dbPath = path.join(config.data_dir, `${projectId}.db`);

    try {
      storage = new SqliteStore(dbPath);
      storage.open();

      const wikiRoot = path.join(config.data_dir, "wiki");
      pageStore = new PageStore(wikiRoot, storage, {
        enabled: true,
        commitPerPage: false,
        batchIntervalMs: 300_000,
      });
      gitLayer = new GitLayer(wikiRoot, {
        enabled: true,
        commitPerPage: false,
        batchIntervalMs: 300_000,
      });
      gitLayer.init();

      buffer = new ObservationBuffer(
        config.buffer_max_size,
        config.buffer_flush_interval_ms
      );
      buffer.attach(storage);

      // ── Retrievers (baseados em páginas) ──
      if (config.retrieval.bm25_enabled) {
        retriever = new Bm25Retriever(storage);
      }

      // ── Vector search (opt-in) ──
      if (config.retrieval.vector.local.enabled || config.retrieval.vector.api.enabled) {
        const apiKey = process.env.VECTOR_API_KEY || "";

        embeddingService = new EmbeddingService({
          model: "all-MiniLM-L6-v2",
          apiModel: config.retrieval.vector.api.model,
          dimension: 384,
          normalize: true,
          apiKey: apiKey || undefined,
          preferApi: config.retrieval.vector.api.enabled && !config.retrieval.vector.local.enabled,
        });

        vectorRetriever = new VectorRetriever(embeddingService);

        embeddingService.initialize().then(() => {
          if (embeddingService?.isReady && storage) {
            // Backfill: gera embeddings para páginas sem embedding
            runEmbeddingBackfill(
              storage,
              embeddingService,
              vectorRetriever!,
              projectId
            ).then((count) => {
              if (count > 0 && ctx?.hasUI) {
                ctx.ui.notify(
                  `🧠 pi-memory: ${count} embeddings gerados`,
                  "info"
                );
              }
            }).catch(() => {});

            // Reconstrói índice com embeddings existentes
            try {
              const embData = storage.getPagesWithEmbeddingData(projectId);
              vectorRetriever!.buildIndex(embData);
            } catch {
              // Índice vazio, continua sem vector search
            }
          }
        }).catch(() => {
          embeddingService = null;
        });
      }

      // ── HybridRetriever ──
      const vectorEnabled = config.retrieval.vector.local.enabled || config.retrieval.vector.api.enabled;
      const needsHybrid = config.retrieval.hybrid_enabled || vectorEnabled;

      if (needsHybrid && retriever) {
        hybridRetriever = new HybridRetriever(
          retriever,
          storage,
          projectId,
          vectorRetriever,
          { vectorEnabled }
        );
      }

      // Função de busca: HybridRetriever → Bm25Retriever → fallback vazio
      const searchFn = hybridRetriever
        ? (query: string) =>
            hybridRetriever!.search(query, config.retrieval.default_top_k)
        : retriever
          ? (query: string) =>
            Promise.resolve(retriever!.search(query, projectId, config.retrieval.default_top_k))
          : async () => [] as RetrievalResult[];

      // ── CacheStableInjector ──
      cacheStableInjector = new CacheStableInjector(
        searchFn,
        {
          debug: false,
          maxBullets: config.max_injected_memories,
          persistentMemCapBytes: config.max_injection_bytes,
          confidenceThreshold: config.injection_confidence_threshold,
        }
      );

      // ── LLM Extractor (N3) ──
      const llmEnabled =
        config.extraction_level === "llm" ||
        config.extraction_level === "kg" ||
        config.llm_extraction.enabled;

      if (llmEnabled) {
        const apiKey = process.env.LLM_API_KEY || "";

        if (apiKey && pageStore) {
          const llmConfig: Partial<LlmExtractorConfig> = {
            apiKey,
            model: config.llm_extraction.model,
            timeoutMs: config.llm_extraction.timeout_ms,
            batchSize: config.llm_extraction.sweep_observation_threshold,
            maxWaitMs: config.llm_extraction.sweep_interval_ms,
          };
          llmExtractor = new LlmExtractor(
            pageStore,
            projectId,
            llmConfig,
            (count) => {
              stats.operations.extractions_n3 += count;
            },
          );
        }
      }

      if (ctx?.hasUI) {
        const pageCount = storage.countPages();
        ctx.ui.notify(
          `🧠 pi-memory carregado (${pageCount} páginas)`,
          "info"
        );
      }
    } catch (err) {
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

    const projectId = hashProjectId(pi.projectDir ?? "default");

    const hooks = createCaptureHooks({
      buffer,
      projectId,
      sessionId,
      observationTtlMs: config.observation_ttl_ms,
    });

    hooks.onToolResult(
      event as Parameters<typeof hooks.onToolResult>[0],
      _ctx
    );

    stats.operations.captures++;
  });

  // ── Lifecycle: before_agent_start ─────────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!cacheStableInjector || !storage) return;

    const projectId = hashProjectId(pi.projectDir ?? "default");

    // CAPTURE: registra user prompt como observação
    if (buffer && sessionId) {
      const hooks = createCaptureHooks({
        buffer,
        projectId,
        sessionId,
        observationTtlMs: config.observation_ttl_ms,
      });
      hooks.onBeforeAgentStart(
        event as Parameters<typeof hooks.onBeforeAgentStart>[0],
        _ctx
      );
      stats.operations.captures++;
    }

    // TTL cleanup best-effort
    try {
      storage.cleanupExpired(Date.now());
    } catch { /* best-effort */ }

    // INJECT: bloco de memória via cache snapshot
    const prompt = (event as { prompt: string }).prompt ?? "";
    const memoryBlock = await cacheStableInjector.getMemoryBlock(prompt);

    stats.operations.injections++;
    stats.kv_cache_stable = cacheStableInjector.isCacheActive;
    stats.kv_cache_age_ms = cacheStableInjector.cacheAge;
    stats.kv_cache_turns_since_rebuild = cacheStableInjector.turnsSinceLastRebuild;

    if (!memoryBlock) {
      return { systemPrompt: (event as { systemPrompt: string }).systemPrompt };
    }

    return {
      systemPrompt: `${(event as { systemPrompt: string }).systemPrompt}\n\n${memoryBlock}`,
    };
  });

  // ── Lifecycle: turn_end ─────────────────────────────────────────
  pi.on("turn_end", async (event, _ctx) => {
    if (!llmExtractor || !storage) return;

    const toolResults: Array<{ toolName?: string }> =
      (event as Record<string, unknown>)["toolResults"] as Array<{ toolName?: string }> ?? [];

    const richTools = new Set(["bash", "write", "edit"]);
    const isRich = toolResults.some(
      (tr) => tr.toolName && richTools.has(tr.toolName),
    );

    if (!isRich) return;

    if (buffer) buffer.flush();

    const projectId = hashProjectId(pi.projectDir ?? "default");
    const pending = storage.getPendingObservations(projectId);

    if (pending.length > 0) {
      llmExtractor.enqueue(pending);
    }
  });

  // ── Lifecycle: session_before_compact ─────────────────────────────
  pi.on("session_before_compact", async (_event, _ctx) => {
    if (cacheStableInjector) {
      cacheStableInjector.invalidate();
    }
  });

  // ── Lifecycle: session_shutdown ───────────────────────────────────
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (buffer) {
      buffer.flush();
      buffer.detach();
      buffer = null;
    }

    if (storage) {
      try { storage.close(); } catch { /* best-effort */ }
      storage = null;
    }

    if (llmExtractor) {
      llmExtractor.shutdown();
      llmExtractor = null;
    }

    retriever = null;
    vectorRetriever = null;
    embeddingService = null;
    hybridRetriever = null;
    pageStore = null;
    gitLayer = null;
    cacheStableInjector = null;
    sessionId = null;
  });

  // ── Tools ─────────────────────────────────────────────────────────
  const projectId = hashProjectId(pi.projectDir ?? "default");

  pi.registerTool({
    ...createMemorySearchTool(
      () => pageStore ?? (null as unknown as PageStore),
      projectId,
    ),
  });

  pi.registerTool({
    ...createMemoryWriteTool(
      () => pageStore ?? (null as unknown as PageStore),
      projectId,
    ),
  });

  pi.registerTool({
    ...createMemoryRestoreTool(() => ({
      pageStore: pageStore ?? (null as unknown as PageStore),
      wikiRoot: path.join(config.data_dir, "wiki"),
      gitLayer,
      projectId,
    })),
  });

  pi.registerTool({
    ...createMemoryStatusTool(() => ({
      storage: storage ?? (null as unknown as IStorage),
      pageStore,
      gitLayer,
    })),
  });

  // ── Command: /memory ──────────────────────────────────────────────
  pi.registerCommand("memory", {
    description: "Configure pi-memory: vector, llm, decay, pruning, clear data. TUI only.",
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => {
      const reloadConfigFromDisk = () => {
        const cfgPath = extraConfigPath();
        try {
          if (fs.existsSync(cfgPath)) {
            const raw = fs.readFileSync(cfgPath, "utf-8");
            const extraCfg = JSON.parse(raw) as Partial<PiMemoryConfig>;
            deepMergeConfig(config, extraCfg as Record<string, unknown>);
          }
        } catch { /* ignora */ }
      };

      const saveConfigToDisk = (patch: Partial<PiMemoryConfig>) => {
        const configPath = extraConfigPath();
        const configDir = path.dirname(configPath);
        fs.mkdirSync(configDir, { recursive: true });

        let existing: Record<string, unknown> = {};
        try {
          if (fs.existsSync(configPath)) {
            existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          }
        } catch { /* ignora */ }

        const merged = { ...existing };
        for (const [key, val] of Object.entries(patch)) {
          if (val !== null && typeof val === "object" && !Array.isArray(val) && typeof existing[key] === "object" && existing[key] !== null && !Array.isArray(existing[key])) {
            merged[key] = { ...(existing[key] as Record<string, unknown>), ...(val as Record<string, unknown>) };
          } else {
            merged[key] = val;
          }
        }
        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
      };

      reloadConfigFromDisk();

      const modeLabel = (feat: string): string => {
        if (feat === "vector") {
          const v = config.retrieval.vector;
          if (v.local.enabled && v.api.enabled) return "local + api";
          if (v.local.enabled) return "local";
          if (v.api.enabled) return "api";
          return "off";
        }
        if (feat === "llm") {
          return config.llm_extraction.enabled ? "api" : "off";
        }
        return "off";
      };

      const pageCount = storage?.countPages() ?? 0;
      const obsCount = storage?.countObservations() ?? 0;
      const pendingExt = storage?.countPendingExtraction() ?? 0;

      if (ctx.mode !== "tui") {
        ctx.ui.notify("/memory requires TUI mode. Run pi without -p/--json flags.", "error");
        return;
      }

      let configTarget: string | null = null;
      try {
        const { Container, SettingsList } = await import("@earendil-works/pi-tui");
        const { getSettingsListTheme } = await import("@earendil-works/pi-coding-agent");
        type SettingItem = import("@earendil-works/pi-tui").SettingItem;

        const vMode = modeLabel("vector");

        const items: SettingItem[] = [
          { id: "vector",  label: "Vector search",     currentValue: vMode, values: [vMode] },
          { id: "llm",     label: "LLM extraction",   currentValue: modeLabel("llm"), values: [modeLabel("llm")] },
          { id: "pruning", label: "Pruning", currentValue: config.consolidation.pruning_enabled ? "on" : "off", values: ["on", "off"] },
          { id: "decay",   label: "Decay",              currentValue: config.consolidation.decay_enabled ? "on" : "off", values: ["on", "off"] },
          { id: "decay_days", label: "Decay (days)",    currentValue: String(config.consolidation.decay_days), values: ["3", "7", "14", "30"] },
          { id: "prune_threshold", label: "Pruning threshold", currentValue: String(config.consolidation.pruning_confidence_threshold), values: ["0.05", "0.1", "0.2", "0.5"] },
          { id: "prune_age", label: "Pruning age (days)", currentValue: String(config.consolidation.pruning_age_days), values: ["7", "30", "60", "90"] },
          { id: "clear",    label: "Clear all data",     currentValue: "clear", values: ["clear"] },
        ];

        await ctx.ui.custom((tui, theme, _kb, done) => {
          const header = "pi-memory (" + pageCount + " pages, " + obsCount + " obs, " + pendingExt + " pending)";
          const container = new Container();
          container.addChild(new (class {
            render(_width: number) { return [theme.fg("accent", theme.bold(header)), ""]; }
            invalidate() {}
          })());

          const settingsList = new SettingsList(
            items,
            Math.min(items.length + 3, 18),
            getSettingsListTheme(),
            (id, newValue) => {
              if (id === "vector" || id === "llm") {
                configTarget = id;
                done(undefined);
                return;
              }
              if (id === "clear") {
                configTarget = "clear";
                done(undefined);
                return;
              }
              if (id === "pruning") {
                const on = newValue === "on";
                saveConfigToDisk({ consolidation: { pruning_enabled: on } } as Partial<PiMemoryConfig>);
                ctx.ui.notify("Pruning: " + (on ? "on" : "off") + ". Run /reload to apply.", "info");
              } else if (id === "decay") {
                const on = newValue === "on";
                saveConfigToDisk({ consolidation: { decay_enabled: on } } as Partial<PiMemoryConfig>);
                ctx.ui.notify("Decay: " + (on ? "on" : "off") + ". Run /reload to apply.", "info");
              } else if (id === "decay_days") {
                saveConfigToDisk({ consolidation: { decay_days: Number(newValue) } } as Partial<PiMemoryConfig>);
                ctx.ui.notify("Decay days: " + newValue + "d. Run /reload to apply.", "info");
              } else if (id === "prune_threshold") {
                saveConfigToDisk({ consolidation: { pruning_confidence_threshold: Number(newValue) } } as Partial<PiMemoryConfig>);
                ctx.ui.notify("Threshold: " + newValue + ". Run /reload to apply.", "info");
              } else if (id === "prune_age") {
                saveConfigToDisk({ consolidation: { pruning_age_days: Number(newValue) } } as Partial<PiMemoryConfig>);
                ctx.ui.notify("Age: " + newValue + "d. Run /reload to apply.", "info");
              }
            },
            () => done(undefined),
            { enableSearch: true },
          );

          container.addChild(settingsList);
          return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data) => settingsList.handleInput?.(data),
          };
        });

        if (configTarget === "vector") {
          const curLocal = config.retrieval.vector.local.enabled;
          const curApi   = config.retrieval.vector.api.enabled;
          const curMode  = curLocal && curApi ? "local + api" : curLocal ? "local" : curApi ? "api" : "off";

          const mode = await ctx.ui.select(
            "Vector mode",
            ["off", "local", "api", "local + api"],
            curMode
          );

          if (mode && mode !== curMode) {
            const wantLocal = mode === "local" || mode === "local + api";
            const wantApi   = mode === "api" || mode === "local + api";

            let hasKey = !!process.env.VECTOR_API_KEY;
            let cancelled = false;

            if (wantApi) {
              const otherKeys: Array<{ label: string; varName: string }> = [];
              if (process.env.LLM_API_KEY) otherKeys.push({ label: "LLM API key", varName: "LLM_API_KEY" });

              if (otherKeys.length > 0) {
                const curVal = process.env.VECTOR_API_KEY;
                const reuseOpts = [
                  curVal ? "Enter different key" : "Enter new key",
                  ...otherKeys.map((k) => `Reuse ${k.label}`),
                ];
                const reuseChoice = await ctx.ui.select("API key for vector", reuseOpts, reuseOpts[0]);

                if (reuseChoice && reuseChoice.startsWith("Reuse")) {
                  const chosen = otherKeys.find((k) => `Reuse ${k.label}` === reuseChoice);
                  if (chosen) { saveEnvKey("VECTOR_API_KEY", process.env[chosen.varName]!); hasKey = true; }
                } else if (curVal) {
                  const result = await ctx.ui.input("API key for vector", "Leave as-is to keep current key, or enter a new one.", curVal);
                  if (result !== null && result !== undefined) { const t = result.trim(); if (t) { saveEnvKey("VECTOR_API_KEY", t); } hasKey = true; } else { cancelled = true; }
                } else {
                  const result = await ctx.ui.input("API key for vector", "Required for API mode.", "");
                  if (result && result.trim()) { saveEnvKey("VECTOR_API_KEY", result.trim()); hasKey = true; } else { cancelled = true; }
                }
              } else {
                const curVal = process.env.VECTOR_API_KEY;
                if (curVal) {
                  const result = await ctx.ui.input("API key for vector", "Leave as-is to keep current key, or enter a new one.", curVal);
                  if (result !== null && result !== undefined) { const t = result.trim(); if (t) { saveEnvKey("VECTOR_API_KEY", t); } hasKey = true; } else { cancelled = true; }
                } else {
                  const result = await ctx.ui.input("API key for vector", "Required for API mode.", "");
                  if (result && result.trim()) { saveEnvKey("VECTOR_API_KEY", result.trim()); hasKey = true; } else { cancelled = true; }
                }
              }
            }

            if (cancelled && !wantLocal) {
              ctx.ui.notify("Vector API mode requires a key. Nothing changed.", "error");
            } else {
              const doLocal = wantLocal;
              const doApi   = wantApi && hasKey;
              saveConfigToDisk({ retrieval: { vector: { local: { enabled: doLocal }, api: { enabled: doApi, model: config.retrieval.vector.api.model } } } } as Partial<PiMemoryConfig>);
              const savedMode = doLocal && doApi ? "local + api" : doLocal ? "local" : doApi ? "api" : "off";
              ctx.ui.notify("Vector: " + savedMode + ". Run /reload to apply.", "success");
            }
          }
        }

        if (configTarget === "llm") {
          const curMode = config.llm_extraction.enabled ? "api" : "off";
          const mode = await ctx.ui.select(
            "LLM extraction mode",
            ["off", "api"],
            curMode
          );

          if (mode && mode !== curMode) {
            if (mode === "off") {
              saveEnvKey("LLM_API_KEY", "");
              saveConfigToDisk({
                extraction_level: "none",
                llm_extraction: { enabled: false },
              } as unknown as Partial<PiMemoryConfig>);
              ctx.ui.notify("LLM extraction disabled. Run /reload to apply.", "success");
            } else {
              const curKey = process.env.LLM_API_KEY || "";
              let hasKey = !!curKey;
              let cancelled = false;

              const otherKeys: Array<{ label: string; varName: string }> = [];
              if (process.env.VECTOR_API_KEY) otherKeys.push({ label: "Vector API key", varName: "VECTOR_API_KEY" });

              if (otherKeys.length > 0) {
                const reuseOpts = [
                  curKey ? "Enter different key" : "Enter new key",
                  ...otherKeys.map((k) => `Reuse ${k.label}`),
                ];
                const reuseChoice = await ctx.ui.select("API key for LLM", reuseOpts, reuseOpts[0]);

                if (reuseChoice && reuseChoice.startsWith("Reuse")) {
                  const chosen = otherKeys.find((k) => `Reuse ${k.label}` === reuseChoice);
                  if (chosen) { saveEnvKey("LLM_API_KEY", process.env[chosen.varName]!); hasKey = true; }
                } else if (curKey) {
                  const result = await ctx.ui.input("API key for LLM", "Leave as-is to keep current key, or enter a new one.", curKey);
                  if (result !== null && result !== undefined) { const t = result.trim(); if (t) { saveEnvKey("LLM_API_KEY", t); } hasKey = true; } else { cancelled = true; }
                } else {
                  const result = await ctx.ui.input("API key for LLM", "Required for LLM extraction.", "");
                  if (result && result.trim()) { saveEnvKey("LLM_API_KEY", result.trim()); hasKey = true; } else { cancelled = true; }
                }
              } else {
                if (curKey) {
                  const result = await ctx.ui.input("API key for LLM", "Leave as-is to keep current key, or enter a new one.", curKey);
                  if (result !== null && result !== undefined) { const t = result.trim(); if (t) { saveEnvKey("LLM_API_KEY", t); } hasKey = true; } else { cancelled = true; }
                } else {
                  const result = await ctx.ui.input("API key for LLM", "Required for LLM extraction.", "");
                  if (result && result.trim()) { saveEnvKey("LLM_API_KEY", result.trim()); hasKey = true; } else { cancelled = true; }
                }
              }

              if (cancelled) {
                ctx.ui.notify("LLM configuration cancelled.", "info");
              } else if (hasKey) {
                const model = "mistralai/mistral-nemo";
                saveConfigToDisk({
                  extraction_level: "llm",
                  llm_extraction: { model, enabled: true },
                } as unknown as Partial<PiMemoryConfig>);
                ctx.ui.notify("LLM configured. Run /reload to apply.", "success");
              }
            }
          }
        }

        if (configTarget === "clear") {
          const confirmed = await ctx.ui.confirm(
            "Clear all data?",
            "This deletes ALL pages and observations for this project. The wiki markdown files on disk are NOT affected. Irreversible."
          );
          if (!confirmed) {
            ctx.ui.notify("Clear cancelled.", "info");
          } else {
            const pid = hashProjectId(pi.projectDir ?? "default");
            let pageDel = 0;
            let obsDel = 0;
            try {
              if (storage) {
                pageDel = storage.deleteAllPages(pid);
                obsDel = storage.deleteAllObservations(pid);
                if (cacheStableInjector) cacheStableInjector.invalidate();
                if (vectorRetriever) vectorRetriever.clear();
                stats = resetStats();
              }
            } catch (e) {
              ctx.ui.notify("Clear failed: " + (e as Error).message, "error");
            }
            if (pageDel > 0 || obsDel > 0) {
              ctx.ui.notify("Cleared: " + pageDel + " pages, " + obsDel + " observations removed.", "success");
            } else {
              ctx.ui.notify("No data found for project " + pid + ".", "warning");
            }
          }
        }
      } catch (e) {
        ctx.ui.notify("TUI error: " + (e as Error).message, "error");
      }
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

function checkRuntime(): void {
  if (typeof (globalThis as any).Bun !== "undefined") return;

  try {
    createRequire(import.meta.url)("better-sqlite3");
  } catch {
    console.warn(
      "[pi-memory] Aviso: better-sqlite3 não encontrado.\n" +
      "  O sistema de memória requer better-sqlite3 para Node.js.\n" +
      "  Instale: npm install better-sqlite3\n" +
      "  Ou use Bun (runtime nativo com bun:sqlite).\n" +
      "  A extensão continuará carregada mas o storage falhará no session_start."
    );
  }
}

function deepMergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (isObj(sv) && isObj(tv)) {
      deepMergeConfig(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      (target as Record<string, unknown>)[key] = sv;
    }
  }
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function envFilePath(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), '.env');
}

function loadEnvFile(): void {
  try {
    const envPath = envFilePath();
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      const cleanVal = val.replace(/^["']|["']$/g, '');
      if (!process.env[key] && cleanVal) {
        process.env[key] = cleanVal;
      }
    }
  } catch {
    // .env é best-effort
  }
}

function saveEnvKey(varName: string, value: string): void {
  try {
    const envPath = envFilePath();
    let lines: string[] = [];
    let found = false;

    if (fs.existsSync(envPath)) {
      lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    }

    if (value) {
      const newLine = `${varName}=${value}`;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith(`${varName}=`)) {
          lines[i] = newLine;
          found = true;
          break;
        }
      }
      if (!found) lines.push(newLine);
      process.env[varName] = value;
    } else {
      lines = lines.filter(l => !l.trimStart().startsWith(`${varName}=`));
      delete process.env[varName];
    }

    fs.writeFileSync(envPath, lines.join('\n').trimEnd() + '\n', 'utf-8');
  } catch {
    // Best-effort
  }
}

function hashProjectId(projectDir: string): string {
  if (!projectDir || projectDir === "default") return "default";
  let hash = 0;
  for (let i = 0; i < projectDir.length; i++) {
    hash = (hash * 31 + projectDir.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

/**
 * Backfill de embeddings: gera e persiste embeddings para páginas
 * que ainda não têm. Atualiza o VectorRetriever incrementalmente.
 */
async function runEmbeddingBackfill(
  storage: IStorage,
  embedService: EmbeddingService,
  vecRetriever: VectorRetriever,
  projectId: string
): Promise<number> {
  const withoutEmb = storage.getPagesWithoutEmbedding(projectId);
  if (withoutEmb.length === 0) return 0;

  const texts = withoutEmb.map((p) => p.body);
  let count = 0;

  try {
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const pageBatch = withoutEmb.slice(i, i + batchSize);

      const embeddings = await embedService.embedBatch(batch);

      for (let j = 0; j < embeddings.length; j++) {
        const page = pageBatch[j];
        const emb = embeddings[j];

        storage.updatePageEmbedding(page.id, emb);
        vecRetriever.upsert(page.id, emb);
        count++;
      }
    }
  } catch {
    // Backfill parcial — próximos ciclos tentam de novo
  }

  return count;
}
