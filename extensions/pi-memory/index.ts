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
import type { PiMemoryConfig, MemoryStats, RetrievalResult } from "./types";
import { UnifiedStore } from "./storage/unified-store";
import type { IStorage } from "./storage/index";
import { ObservationBuffer } from "./capture/buffer";
import { createCaptureHooks } from "./capture/hooks";
import { RegexExtractor } from "./extract/regex-extractor";
import { LlmExtractor } from "./extract/llm-extractor";
import type { LlmExtractorConfig } from "./extract/llm-extractor";
import { SweepConsolidator } from "./consolidate/sweep";
import { Bm25Retriever } from "./retrieve/bm25";
import { EmbeddingService } from "./utils/embedding";
import { VectorRetriever } from "./retrieve/vector";
import { RerankerService } from "./retrieve/reranker";
import { HybridRetriever } from "./retrieve/index";
import { CacheStableInjector } from "./inject/snapshot";
import { createMemorySearchTool } from "./tools/memory-search";
import { createMemoryWriteTool } from "./tools/memory-write";
import { createMemoryStatusTool } from "./tools/memory-status";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

// ── Estado interno ─────────────────────────────────────────────────────
let config: PiMemoryConfig;
let stats: MemoryStats;
let storage: IStorage | null = null;
let buffer: ObservationBuffer | null = null;
let retriever: Bm25Retriever | null = null;
let regexExtractor: RegexExtractor | null = null;
let llmExtractor: LlmExtractor | null = null;
let sweepConsolidator: SweepConsolidator | null = null;
let embeddingService: EmbeddingService | null = null;
let vectorRetriever: VectorRetriever | null = null;
let rerankerService: RerankerService | null = null;
let hybridRetriever: HybridRetriever | null = null;
let cacheStableInjector: CacheStableInjector | null = null;
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
  // ── Carregar .env (API key segura, fora do alcance do agente) ─────
  loadEnvFile();

  // ── Flag ──────────────────────────────────────────────────────────
  pi.registerFlag?.("no-memory", {
    description: "Disable persistent memory for this session",
  });

  // ── Carregar configuração (inclui migração automática) ──
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

      // Inicializa retriever (BM25), se habilitado
      if (config.retrieval.bm25_enabled) {
        retriever = new Bm25Retriever(storage);
      }

      // Inicializa embedding service + vector retriever (Fase 2.4)
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

        // Cria VectorRetriever imediatamente (síncrono) — referência válida
        // para HybridRetriever. O índice começa vazio; busca degrada
        // graciosamente via catch até o embedding service ficar pronto.
        vectorRetriever = new VectorRetriever(embeddingService);

        // Inicializa em background (não bloqueia session_start)
        embeddingService.initialize().then(() => {
          if (embeddingService?.isReady && storage) {
            // Backfill: gera embeddings para memórias sem embedding
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
            }).catch(() => {
              // Backfill falhou, mas o sistema continua funcional
            });

            // Reconstrói índice com embeddings existentes
            try {
              const withEmb = storage.getMemoriesWithEmbeddings(projectId);
              vectorRetriever!.buildIndex(withEmb);
            } catch {
              // Índice vazio, continua sem vector search
            }
          }
        }).catch(() => {
          // Embedding service falhou, sistema continua com BM25 apenas
          embeddingService = null;
        });
      }

      // Inicializa reranker (Fase 2.5) — background, não bloqueia
      if (config.retrieval.reranker.local.enabled || config.retrieval.reranker.api.enabled) {
        const rerankerApiKey = process.env.RERANKER_API_KEY || "";

        rerankerService = new RerankerService({
          model: "Xenova/ms-marco-MiniLM-L-6-v2",
          apiModel: config.retrieval.reranker.api.model,
          apiKey: rerankerApiKey || undefined,
          preferApi: config.retrieval.reranker.api.enabled && !config.retrieval.reranker.local.enabled,
        });
        rerankerService.initialize().catch(() => {
          rerankerService = null;
        });
      }

      // Inicializa HybridRetriever (Fase 2.5) — quando hybrid, vector ou reranker habilitado
      const vectorEnabled = config.retrieval.vector.local.enabled || config.retrieval.vector.api.enabled;
      const rerankerEnabled = config.retrieval.reranker.local.enabled || config.retrieval.reranker.api.enabled;
      const needsHybrid =
        config.retrieval.hybrid_enabled ||
        vectorEnabled ||
        rerankerEnabled;

      if (needsHybrid && retriever) {
        hybridRetriever = new HybridRetriever(
          retriever,
          storage,
          projectId,
          vectorRetriever,
          rerankerService,
          {
            vectorEnabled,
            rerankerEnabled,
          }
        );
      }

      // Função de busca: HybridRetriever → Bm25Retriever → fallback vazio
      const searchFn = hybridRetriever
        ? (query: string) =>
            hybridRetriever!.search(query, config.retrieval.default_top_k)
        : retriever
          ? (query: string) =>
            Promise.resolve(retriever!.search(query, projectId, config.retrieval.default_top_k))
          : async () => [];

      // Inicializa CacheStableInjector (Fase 2.6)
      cacheStableInjector = new CacheStableInjector(
        searchFn,
        {
          debug: false,
          maxBullets: config.max_injected_memories,
          persistentMemCapBytes: config.max_injection_bytes,
          confidenceThreshold: config.injection_confidence_threshold,
        }
      );

      // Inicializa extrator N2 (regex) se configurado
      if (config.extraction_level !== "none") {
        regexExtractor = new RegexExtractor();
      }

      // Inicializa extrator N3 (LLM) se configurado
      const llmEnabled =
        config.extraction_level === "llm" ||
        config.extraction_level === "kg" ||
        config.llm_extraction.enabled;

      if (llmEnabled) {
        const apiKey = process.env.LLM_API_KEY || "";

        if (apiKey) {
          const llmConfig: Partial<LlmExtractorConfig> = {
            apiKey,
            model: config.llm_extraction.model,
            timeoutMs: config.llm_extraction.timeout_ms,
            batchSize: config.llm_extraction.sweep_observation_threshold,
            maxWaitMs: config.llm_extraction.sweep_interval_ms,
            dedupEnabled: config.consolidation.dedup_enabled,
          };
          llmExtractor = new LlmExtractor(
            storage,
            projectId,
            llmConfig,
            (count) => {
              stats.operations.extractions_n3 += count;
            },
          );

          // Inicializa sweep consolidator (N2)
          sweepConsolidator = new SweepConsolidator(
            storage,
            llmExtractor,
            projectId,
            {
              intervalMs: config.llm_extraction.sweep_interval_ms,
              observationThreshold: config.llm_extraction.sweep_observation_threshold,
              decayEnabled: config.consolidation.decay_enabled,
              decayDays: config.consolidation.decay_days,
              decayFactor: config.consolidation.decay_factor,
              pruningEnabled: config.consolidation.pruning_enabled,
              pruningConfidenceThreshold: config.consolidation.pruning_confidence_threshold,
              pruningAgeDays: config.consolidation.pruning_age_days,
            },
            () => {
              stats.operations.consolidations_n2++;
            },
          );
          sweepConsolidator.schedule();
        }
      }

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

    const projectId = hashProjectId(pi.projectDir ?? "default");

    const hooks = createCaptureHooks({
      buffer,
      projectId,
      sessionId,
      regexExtractor: regexExtractor ?? undefined,
      storage: storage ?? undefined,
      onN2Extraction: (count) => {
        stats.operations.extractions_n2 += count;
      },
      observationTtlMs: config.observation_ttl_ms,
      dedupEnabled: config.consolidation.dedup_enabled,
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

    // 1. CAPTURE: registra user prompt como observação
    if (buffer && sessionId) {
      const hooks = createCaptureHooks({
        buffer,
        projectId,
        sessionId,
        regexExtractor: regexExtractor ?? undefined,
        storage: storage ?? undefined,
        observationTtlMs: config.observation_ttl_ms,
        dedupEnabled: config.consolidation.dedup_enabled,
      });
      hooks.onBeforeAgentStart(
        event as Parameters<typeof hooks.onBeforeAgentStart>[0],
        _ctx
      );
      stats.operations.captures++;
    }

    // TTL cleanup: se não há sweep (N3 desligado), limpa observações expiradas
    // a cada turno para evitar acúmulo infinito
    if (!sweepConsolidator && storage) {
      try {
        storage.cleanupExpired(Date.now());
      } catch {
        // Best-effort
      }
    }

    // 2. INJECT: bloco de memória via cache snapshot (Fase 2.6)
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

    // Verifica se turno foi "rico" (teve bash/edit/write)
    const toolResults: Array<{ toolName?: string }> =
      (event as Record<string, unknown>)["toolResults"] as Array<{ toolName?: string }> ?? [];

    const richTools = new Set(["bash", "write", "edit"]);
    const isRich = toolResults.some(
      (tr) => tr.toolName && richTools.has(tr.toolName),
    );

    if (!isRich) return;

    // Flush buffer para garantir que observações estão no storage
    if (buffer) buffer.flush();

    // Coleta observações pendentes de extração
    const projectId = hashProjectId(pi.projectDir ?? "default");
    const pending = storage.getPendingObservations(projectId);

    if (pending.length > 0) {
      llmExtractor.enqueue(pending);
    }
  });

  // ── Lifecycle: session_before_compact ─────────────────────────────
  pi.on("session_before_compact", async (_event, _ctx) => {
    // Invalida snapshot: handoff capturado, rebuild obrigatório
    if (cacheStableInjector) {
      cacheStableInjector.invalidate();
    }
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

    // Shutdown N3 extractor
    if (llmExtractor) {
      llmExtractor.shutdown();
      llmExtractor = null;
    }

    // Stop sweep
    if (sweepConsolidator) {
      sweepConsolidator.stop();
      sweepConsolidator = null;
    }

    retriever = null;
    regexExtractor = null;
    vectorRetriever = null;
    embeddingService = null;
    rerankerService = null;
    hybridRetriever = null;
    cacheStableInjector = null;
    sessionId = null;
  });

  // ── Tools ─────────────────────────────────────────────────────────
  const projectId = hashProjectId(pi.projectDir ?? "default");

  // Tools recebem storage/retriever via closure.
  // Se storage ainda não foi inicializado (antes de session_start),
  // a tool falhará graciosamente (retorna erro).
  // Memory search: HybridRetriever → Bm25Retriever → fallback vazio
  const searchProvider = hybridRetriever
    ? {
        search: (query: string, _pid: string, topK?: number) =>
          hybridRetriever!.search(query, topK ?? 10),
      }
    : retriever
      ? {
          search: (query: string, pid: string, topK?: number) =>
            Promise.resolve(retriever!.search(query, pid, topK)),
        }
      : {
          search: async () => [] as RetrievalResult[],
        };

  pi.registerTool({
    ...createMemorySearchTool(searchProvider, projectId),
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
      () => sessionId ?? "unknown",
      // Callback pós-write: gera embedding, atualiza índice, invalida cache
      async (memory) => {
        // Invalida cache snapshot (Fase 2.6)
        if (cacheStableInjector) cacheStableInjector.invalidate();

        if (!embeddingService?.isReady || !vectorRetriever || !storage) return;
        try {
          const emb = await embeddingService.embed(memory.text);
          storage.updateEmbedding(memory.id, emb);
          vectorRetriever.upsert({ ...memory, embedding: emb });
        } catch {
          // Embedding falhou — sistema continua sem vector para esta memória
        }
      },
      config.consolidation.dedup_enabled
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

  // ── Command: /memory ──────────────────────────────────────────────
  pi.registerCommand("memory", {
    description: "Configure pi-memory: vector/llm/reranker mode, decay, pruning, clear. TUI only.",
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => {
      // helper: recarrega config do disco para o modulo
      const reloadConfigFromDisk = () => {
        const projDir = ctx.cwd;
        if (!projDir) return;
        const localPath = path.join(projDir, ".pi", "memory.json");
        try {
          if (fs.existsSync(localPath)) {
            const raw = fs.readFileSync(localPath, "utf-8");
            const localCfg = JSON.parse(raw) as Partial<PiMemoryConfig>;
            deepMergeConfig(config, localCfg as Record<string, unknown>);
          }
        } catch { /* ignora */ }
      };

      // helper: salva config no .pi/memory.json
      const saveConfigToDisk = (patch: Partial<PiMemoryConfig>) => {
        const projDir = ctx.cwd;
        if (!projDir) {
          ctx.ui.notify("No project directory - config not saved", "error");
          return;
        }
        const configDir = path.join(projDir, ".pi");
        const configPath = path.join(configDir, "memory.json");
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

      // helpers de display
      const modeLabel = (feat: string): string => {
        if (feat === "vector") {
          const v = config.retrieval.vector;
          if (v.local.enabled && v.api.enabled) return "local + api";
          if (v.local.enabled) return "local";
          if (v.api.enabled) return "api";
          return "off";
        }
        if (feat === "reranker") {
          const r = config.retrieval.reranker;
          if (r.local.enabled && r.api.enabled) return "local + api";
          if (r.local.enabled) return "local";
          if (r.api.enabled) return "api";
          return "off";
        }
        if (feat === "llm") {
          return config.llm_extraction.enabled ? config.llm_extraction.model : "off";
        }
        return "off";
      };

      const memCount = storage?.countMemories() ?? 0;
      const obsCount = storage?.countObservations() ?? 0;
      const pendingExt = storage?.countPendingExtraction() ?? 0;

      if (ctx.mode !== "tui") {
        ctx.ui.notify("/memory requires TUI mode. Run pi without -p/--json flags.", "error");
        return;
      }

      // TUI: SettingsList
      let configTarget: string | null = null;
      try {
        const { Container, SettingsList } = await import("@earendil-works/pi-tui");
        const { getSettingsListTheme } = await import("@earendil-works/pi-coding-agent");
        type SettingItem = import("@earendil-works/pi-tui").SettingItem;

        const vMode = modeLabel("vector");
        const rMode = modeLabel("reranker");

        const items: SettingItem[] = [
          { id: "vector",  label: "Vector search",     currentValue: vMode, values: [vMode] },
          { id: "llm",     label: "LLM extraction N3", currentValue: modeLabel("llm"), values: [modeLabel("llm")] },
          { id: "reranker", label: "Reranker",          currentValue: rMode, values: [rMode] },
          { id: "pruning", label: "Pruning", currentValue: config.consolidation.pruning_enabled ? "on" : "off", values: ["on", "off"] },
          { id: "decay",   label: "Decay (days)",      currentValue: String(config.consolidation.decay_days), values: ["3", "7", "14", "30"] },
          { id: "prune_threshold", label: "Pruning threshold", currentValue: String(config.consolidation.pruning_confidence_threshold), values: ["0.05", "0.1", "0.2", "0.5"] },
          { id: "prune_age", label: "Pruning age (days)", currentValue: String(config.consolidation.pruning_age_days), values: ["7", "30", "60", "90"] },
          { id: "clear",    label: "Clear all memories",     currentValue: "clear", values: ["clear"] },
        ];

        await ctx.ui.custom((tui, theme, _kb, done) => {
          const header = "pi-memory (" + memCount + " mem, " + obsCount + " obs, " + pendingExt + " pending)";
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
              if (id === "vector" || id === "reranker" || id === "llm") {
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
                saveConfigToDisk({ consolidation: { decay_days: Number(newValue) } } as Partial<PiMemoryConfig>);
                ctx.ui.notify("Decay: " + newValue + "d. Run /reload to apply.", "info");
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

        // Configuracao externa (apos fechar SettingsList)
        if (configTarget === "vector" || configTarget === "reranker") {
          const isVec = configTarget === "vector";
          const curLocal = isVec ? config.retrieval.vector.local.enabled : config.retrieval.reranker.local.enabled;
          const curApi   = isVec ? config.retrieval.vector.api.enabled   : config.retrieval.reranker.api.enabled;
          const curMode  = curLocal && curApi ? "local + api" : curLocal ? "local" : curApi ? "api" : "off";

          const mode = await ctx.ui.select(
            configTarget + " mode",
            ["off", "local", "api", "local + api"],
            curMode
          );

          if (mode && mode !== curMode) {
            const wantLocal = mode === "local" || mode === "local + api";
            const wantApi   = mode === "api" || mode === "local + api";

            // Define env var name for this service
            const envVarName = isVec ? "VECTOR_API_KEY" : "RERANKER_API_KEY";

            // Se quer API, sempre oferece input de chave (com default da atual)
            // ou reuso de chave de outro serviço
            let hasKey = !!process.env[envVarName];
            let cancelled = false;

            if (wantApi) {
              // Coleta chaves existentes de outros serviços
              const existingKeys: Array<{ label: string; varName: string }> = [];
              if (process.env.LLM_API_KEY) existingKeys.push({ label: "LLM API key", varName: "LLM_API_KEY" });
              if (isVec && process.env.RERANKER_API_KEY) existingKeys.push({ label: "Reranker API key", varName: "RERANKER_API_KEY" });
              if (!isVec && process.env.VECTOR_API_KEY) existingKeys.push({ label: "Vector API key", varName: "VECTOR_API_KEY" });

              // Filtra a própria chave (não oferece reuso dela mesma)
              const otherKeys = existingKeys.filter((k) => k.varName !== envVarName);

              // Monta opções: input direto OU reuso de outro serviço
              if (otherKeys.length > 0) {
                const curVal = process.env[envVarName];
                const reuseOpts = [
                  curVal ? "Enter different key" : "Enter new key",
                  ...otherKeys.map((k) => `Reuse ${k.label}`),
                ];
                const reuseChoice = await ctx.ui.select(
                  "API key for " + configTarget,
                  reuseOpts,
                  reuseOpts[0]
                );

                if (reuseChoice && reuseChoice.startsWith("Reuse")) {
                  const chosen = otherKeys.find((k) => `Reuse ${k.label}` === reuseChoice);
                  if (chosen) {
                    saveEnvKey(envVarName, process.env[chosen.varName]!);
                    hasKey = true;
                  }
                } else if (curVal) {
                  // Já tem chave — pode ter escolhido "Enter different key"
                  // Mostra input com a atual como default
                  const result = await ctx.ui.input(
                    "API key for " + configTarget,
                    "Leave as-is to keep current key, or enter a new one.",
                    curVal
                  );
                  if (result !== null && result !== undefined) {
                    const trimmed = result.trim();
                    if (trimmed && trimmed !== curVal) {
                      saveEnvKey(envVarName, trimmed);
                    }
                    hasKey = true;
                  } else {
                    cancelled = true;
                  }
                } else {
                  // Não tem chave — mostra input vazio
                  const result = await ctx.ui.input(
                    "API key for " + configTarget,
                    "Required for API mode. Will be saved to extensions/pi-memory/.env",
                    ""
                  );
                  if (result && result.trim()) {
                    saveEnvKey(envVarName, result.trim());
                    hasKey = true;
                  } else {
                    cancelled = true;
                  }
                }
              } else {
                // Nenhuma outra chave disponível — input direto
                const curVal = process.env[envVarName];
                if (curVal) {
                  const result = await ctx.ui.input(
                    "API key for " + configTarget,
                    "Leave as-is to keep current key, or enter a new one.",
                    curVal
                  );
                  if (result !== null && result !== undefined) {
                    const trimmed = result.trim();
                    if (trimmed && trimmed !== curVal) {
                      saveEnvKey(envVarName, trimmed);
                    }
                    hasKey = true;
                  } else {
                    cancelled = true;
                  }
                } else {
                  const result = await ctx.ui.input(
                    "API key for " + configTarget,
                    "Required for API mode. Will be saved to extensions/pi-memory/.env",
                    ""
                  );
                  if (result && result.trim()) {
                    saveEnvKey(envVarName, result.trim());
                    hasKey = true;
                  } else {
                    cancelled = true;
                  }
                }
              }
            }

            if (cancelled && !wantLocal) {
              ctx.ui.notify(configTarget + " API mode requires a key. Nothing changed.", "error");
            } else {
              const doLocal = wantLocal;
              const doApi   = wantApi && hasKey;
              const patch = isVec
                ? { retrieval: { vector: { local: { enabled: doLocal }, api: { enabled: doApi, model: config.retrieval.vector.api.model } } } }
                : { retrieval: { reranker: { local: { enabled: doLocal }, api: { enabled: doApi, model: config.retrieval.reranker.api.model } } } };
              saveConfigToDisk(patch as Partial<PiMemoryConfig>);
              const savedMode = doLocal && doApi ? "local + api" : doLocal ? "local" : doApi ? "api" : "off";
              ctx.ui.notify(configTarget + ": " + savedMode + ". Run /reload to apply.", "success");
            }
          }
        }

        if (configTarget === "llm") {
          const curKey = process.env.LLM_API_KEY || "";
          const k = await ctx.ui.input(
            "API key for LLM",
            "Will be saved to extensions/pi-memory/.env. Leave empty and confirm to disable.",
            curKey
          );
          if (k === undefined || k === null) {
            // Cancelado — não faz nada
          } else {
            const trimmed = k.trim();
            let effectiveKey = trimmed;

            // Se não digitou chave nova e não tem LLM_API_KEY, oferece reuso
            if (!effectiveKey && !curKey) {
              const existingKeys: Array<{ label: string; varName: string }> = [];
              if (process.env.VECTOR_API_KEY) existingKeys.push({ label: "Vector API key", varName: "VECTOR_API_KEY" });
              if (process.env.RERANKER_API_KEY) existingKeys.push({ label: "Reranker API key", varName: "RERANKER_API_KEY" });

              if (existingKeys.length > 0) {
                const reuseOpts = ["Enter new key", ...existingKeys.map((ek) => `Reuse ${ek.label}`)];
                const reuseChoice = await ctx.ui.select(
                  "API key for LLM",
                  reuseOpts,
                  "Enter new key"
                );
                if (reuseChoice && reuseChoice.startsWith("Reuse")) {
                  const chosen = existingKeys.find((ek) => `Reuse ${ek.label}` === reuseChoice);
                  if (chosen) {
                    effectiveKey = process.env[chosen.varName]!;
                  }
                }
              }
            }

            const hasKey = effectiveKey.length > 0;

            if (hasKey) {
              saveEnvKey("LLM_API_KEY", effectiveKey);
              // Único modelo suportado atualmente
              const model = "deepseek/deepseek-v4-flash";
              saveConfigToDisk({
                extraction_level: "llm",
                llm_extraction: { model, enabled: true },
              } as unknown as Partial<PiMemoryConfig>);
            } else if (curKey.length > 0) {
              // Remove chave existente — desabilita
              saveEnvKey("LLM_API_KEY", "");
              saveConfigToDisk({
                extraction_level: "regex",
                llm_extraction: { enabled: false },
              } as unknown as Partial<PiMemoryConfig>);
            }

            ctx.ui.notify("LLM configured. Run /reload to apply.", "success");
          }
        }

        // Clear: confirmacao + delecao
        if (configTarget === "clear") {
          const confirmed = await ctx.ui.confirm(
            "Clear all memories?",
            "This deletes ALL memories and observations for this project. Irreversible."
          );
          if (!confirmed) {
            ctx.ui.notify("Clear cancelled.", "info");
          } else {
            // Usa pi.projectDir (mesmo do session_start), não ctx.cwd (que difere)
            const pid = hashProjectId(pi.projectDir ?? "default");
            let memDel = 0;
            let obsDel = 0;
            try {
              if (storage) {
                memDel = storage.deleteAllMemories(pid);
                obsDel = storage.deleteAllObservations(pid);
                if (cacheStableInjector) cacheStableInjector.invalidate();
                if (vectorRetriever) vectorRetriever.clear();
                stats = resetStats();
              }
            } catch (e) {
              ctx.ui.notify("Clear failed: " + (e as Error).message, "error");
            }
            if (memDel > 0 || obsDel > 0) {
              ctx.ui.notify("Cleared: " + memDel + " memories, " + obsDel + " observations deleted.", "success");
            } else {
              ctx.ui.notify("No memories found for project " + pid + ".", "warning");
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

/** Faz deep merge de um patch no objeto config em memória (mutação in-place) */
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

/** Caminho do arquivo .env relativo a este módulo */
function envFilePath(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), '.env');
}

/**
 * Carrega variáveis do arquivo .env para process.env.
 * Apenas chaves ainda não definidas (não sobrescreve env vars existentes).
 * Inclui migração automática: OPENROUTER_API_KEY → LLM_API_KEY / VECTOR_API_KEY / RERANKER_API_KEY.
 */
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
      // Remove quotes wrapping
      const cleanVal = val.replace(/^["']|["']$/g, '');
      // Só define se não existir (env var do shell tem prioridade)
      if (!process.env[key] && cleanVal) {
        process.env[key] = cleanVal;
      }
    }

    // ── Migração: OPENROUTER_API_KEY → LLM_API_KEY / VECTOR_API_KEY / RERANKER_API_KEY ──
    const oldKey = process.env["OPENROUTER_API_KEY"];
    if (oldKey) {
      if (!process.env["LLM_API_KEY"]) process.env["LLM_API_KEY"] = oldKey;
      if (!process.env["VECTOR_API_KEY"]) process.env["VECTOR_API_KEY"] = oldKey;
      if (!process.env["RERANKER_API_KEY"]) process.env["RERANKER_API_KEY"] = oldKey;
    }
  } catch {
    // .env é best-effort
  }
}

/**
 * Salva (ou remove) uma variável de ambiente no arquivo .env.
 * Se value for vazia, remove a linha do arquivo.
 */
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
      // Remove linha
      lines = lines.filter(l => !l.trimStart().startsWith(`${varName}=`));
      delete process.env[varName];
    }

    fs.writeFileSync(envPath, lines.join('\n').trimEnd() + '\n', 'utf-8');
  } catch {
    // Best-effort
  }
}

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

/**
 * Backfill de embeddings: gera e persiste embeddings para memórias
 * que ainda não têm. Atualiza o VectorRetriever incrementalmente.
 *
 * @returns Número de embeddings gerados
 */
async function runEmbeddingBackfill(
  storage: IStorage,
  embedService: EmbeddingService,
  vecRetriever: VectorRetriever,
  projectId: string
): Promise<number> {
  const withoutEmb = storage.getMemoriesWithoutEmbedding(projectId);
  if (withoutEmb.length === 0) return 0;

  const texts = withoutEmb.map((m) => m.text);
  let count = 0;

  try {
    // Processa em lotes de 32 para não sobrecarregar memória
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const memoryBatch = withoutEmb.slice(i, i + batchSize);

      const embeddings = await embedService.embedBatch(batch);

      for (let j = 0; j < embeddings.length; j++) {
        const mem = memoryBatch[j];
        const emb = embeddings[j];

        storage.updateEmbedding(mem.id, emb);
        vecRetriever.upsert({ ...mem, embedding: emb });
        count++;
      }
    }
  } catch {
    // Backfill parcial — próximos sweeps tentam de novo
  }

  return count;
}
