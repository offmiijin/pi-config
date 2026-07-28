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

      // Inicializa embedding service + vector retriever (Fase 2.4)
      if (config.retrieval.vector_enabled) {
        const apiKey =
          process.env.OPENROUTER_API_KEY ?? "";

        embeddingService = new EmbeddingService({
          model: "all-MiniLM-L6-v2",
          dimension: 384,
          normalize: true,
          apiKey: apiKey || undefined,
        });

        // Inicializa em background (não bloqueia session_start)
        embeddingService.initialize().then(() => {
          if (embeddingService?.isReady && storage) {
            vectorRetriever = new VectorRetriever(embeddingService);

            // Backfill: gera embeddings para memórias sem embedding
            runEmbeddingBackfill(
              storage,
              embeddingService,
              vectorRetriever,
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
              vectorRetriever.buildIndex(withEmb);
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
      if (config.retrieval.reranker_enabled) {
        const rerankerApiKey =
          process.env.OPENROUTER_API_KEY ?? "";

        rerankerService = new RerankerService({
          model: "Xenova/ms-marco-MiniLM-L-6-v2",
          apiKey: rerankerApiKey || undefined,
          apiModel: "cohere/rerank-4-pro",
        });
        rerankerService.initialize().catch(() => {
          rerankerService = null;
        });
      }

      // Inicializa HybridRetriever (Fase 2.5)
      hybridRetriever = new HybridRetriever(
        retriever,
        storage,
        projectId,
        vectorRetriever,
        rerankerService,
        {
          vectorEnabled: config.retrieval.vector_enabled,
          rerankerEnabled: config.retrieval.reranker_enabled,
        }
      );

      // Inicializa CacheStableInjector (Fase 2.6)
      cacheStableInjector = new CacheStableInjector(
        (query: string) =>
          hybridRetriever!.search(query, config.retrieval.default_top_k),
        { debug: false }
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
        const apiKey =
          process.env.OPENROUTER_API_KEY ?? "";

        if (apiKey) {
          const llmConfig: Partial<LlmExtractorConfig> = {
            apiKey,
            model: config.llm_extraction.model,
            timeoutMs: config.llm_extraction.timeout_ms,
            batchSize: config.llm_extraction.sweep_observation_threshold,
            maxWaitMs: config.llm_extraction.sweep_interval_ms,
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
              pruningEnabled: true,
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
      });
      hooks.onBeforeAgentStart(
        event as Parameters<typeof hooks.onBeforeAgentStart>[0],
        _ctx
      );
      stats.operations.captures++;
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
  pi.registerTool({
    ...createMemorySearchTool(
      hybridRetriever
        ? {
            search: (query: string, _pid: string, topK?: number) =>
              hybridRetriever!.search(query, topK ?? 10),
          }
        : {
            search: (query: string, pid: string, topK?: number) =>
              retriever!.search(query, pid, topK),
          },
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
      }
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
    description:
      "Configure pi-memory features: vector search, LLM extraction, reranker, decay, pruning. " +
      "Usage: /memory [feature] [true|false] | /memory clear [--force]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const subcmd = parts[0]?.toLowerCase();

      // ── helper: recarrega config do disco para o módulo ──
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

      // ── helper: salva config no .pi/memory.json ──
      const saveConfigToDisk = (patch: Partial<PiMemoryConfig>) => {
        const projDir = ctx.cwd;
        if (!projDir) {
          ctx.ui.notify("No project directory — config not saved", "error");
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

      // Recarrega config do disco ANTES de qualquer operação
      reloadConfigFromDisk();

      // ── helper: toggle via args (CLI mode) ──
      const toggleArg = (label: string, jsonPath: string[], current: boolean) => {
        const val = parts[1]?.toLowerCase();
        if (val !== "true" && val !== "false") {
          ctx.ui.notify(
            `${label}: ${current}. Use \`/memory ${parts[0]} true|false\` to toggle.`,
            "info"
          );
          return;
        }
        const enable = val === "true";
        if (enable === current) {
          ctx.ui.notify(`${label} already ${enable}`, "info");
          return;
        }
        let patch: Record<string, unknown> = {};
        let target: Record<string, unknown> = patch;
        for (let i = 0; i < jsonPath.length - 1; i++) {
          const next: Record<string, unknown> = {};
          target[jsonPath[i]] = next;
          target = next;
        }
        target[jsonPath[jsonPath.length - 1]] = enable;
        saveConfigToDisk(patch as Partial<PiMemoryConfig>);
        ctx.ui.notify(
          `${label}: ${enable}. Run \`/reload\` to apply.`,
          "success"
        );
      };

      // Se tem subcomando: modo CLI direto
      if (subcmd && subcmd !== "interactive") {
        switch (subcmd) {
          case "vector":
            toggleArg("Vector search", ["retrieval", "vector_enabled"], config.retrieval.vector_enabled);
            break;
          case "llm":
            toggleArg("LLM extraction N3", ["llm_extraction", "enabled"], config.llm_extraction.enabled);
            break;
          case "reranker":
            toggleArg("Reranker", ["retrieval", "reranker_enabled"], config.retrieval.reranker_enabled);
            break;
          case "decay":
            toggleArg("Confidence decay", ["consolidation", "decay_enabled"], config.consolidation.decay_enabled);
            break;
          case "pruning":
            // pruning usa threshold > 0 como flag
            toggleArg("Pruning", ["consolidation", "pruning_confidence_threshold"], config.consolidation.pruning_confidence_threshold > 0);
            break;

          case "clear": {
            const force = parts.includes("--force");
            const confirmed = force || (ctx.hasUI && await ctx.ui.confirm("Clear all memories?", "This deletes ALL memories and observations for this project. Irreversible."));
            if (!confirmed) {
              ctx.ui.notify("Clear cancelled.", "info");
              break;
            }
            const pid = hashProjectId(ctx.cwd ?? "default");
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
              ctx.ui.notify(`Clear failed: ${(e as Error).message}`, "error");
              break;
            }
            ctx.ui.notify(`Cleared: ${memDel} memories, ${obsDel} observations deleted.`, "success");
            break;
          }

          case "all": {
            const val = parts[1]?.toLowerCase();
            if (val !== "true" && val !== "false") {
              ctx.ui.notify("Use \`/memory all true|false\`", "info");
              break;
            }
            const enable = val === "true";
            saveConfigToDisk({
              llm_extraction: { enabled: enable },
              retrieval: {
                vector_enabled: enable,
                reranker_enabled: enable,
              },
              consolidation: {
                decay_enabled: enable,
                pruning_confidence_threshold: enable ? 0.1 : 0,
                pruning_age_days: 30,
              },
            } as Partial<PiMemoryConfig>);
            ctx.ui.notify(
              `All features: ${enable}. Run \`/reload\` to apply.`,
              "success"
            );
            break;
          }
          default:
            ctx.ui.notify("Unknown feature. Try: vector, llm, reranker, decay, pruning, all", "error");
        }
        return;
      }

      // ── Interativo (TUI) ou status (não-TUI) ──
      const memCount = storage?.countMemories() ?? 0;
      const obsCount = storage?.countObservations() ?? 0;
      const pendingExt = storage?.countPendingExtraction() ?? 0;

      if (ctx.mode !== "tui") {
        const lines = [
          "🧠 pi-memory configuration",
          "",
          "── Features ──",
          `  Vector search:  ${config.retrieval.vector_enabled}`,
          `  LLM extraction: ${config.llm_extraction.enabled}  (model: ${config.llm_extraction.model})`,
          `  Reranker:       ${config.retrieval.reranker_enabled}`,
          `  Decay:          ${config.consolidation.decay_enabled}`,
          `  Pruning:        ${config.consolidation.pruning_confidence_threshold > 0}`,
          "",
          "── Stats ──",
          `  Memories:     ${memCount}`,
          `  Observations: ${obsCount}`,
          `  Pending ext:  ${pendingExt}`,
          "",
          "── Usage ──",
          '  /memory vector|llm|reranker|decay|pruning true|false',
          '    Ex.: /memory vector true         Ativa vector search',
          '         /memory llm false            Desativa extração LLM',
          '         /memory pruning true         Ativa pruning',
          '',
          '  /memory all true|false              Toggle all features',
          '  /memory clear [--force]             Delete ALL memories',
          '',
          'Changes saved to .pi/memory.json. Run /reload to apply.',
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // ── TUI: SettingsList interativo ──
      try {
        const { Container, SettingsList, Text } = await import("@earendil-works/pi-tui");
        const { getSettingsListTheme } = await import("@earendil-works/pi-coding-agent");
        type SettingItem = import("@earendil-works/pi-tui").SettingItem;

        const items: SettingItem[] = [
          {
            id: "vector",
            label: "Vector search",
            currentValue: String(config.retrieval.vector_enabled),
            values: ["true", "false"],
          },
          {
            id: "llm",
            label: "LLM extraction N3",
            currentValue: String(config.llm_extraction.enabled),
            values: ["true", "false"],
          },
          {
            id: "reranker",
            label: "Reranker",
            currentValue: String(config.retrieval.reranker_enabled),
            values: ["true", "false"],
          },
          {
            id: "decay",
            label: "Confidence decay",
            currentValue: String(config.consolidation.decay_enabled),
            values: ["true", "false"],
          },
          {
            id: "pruning",
            label: "Pruning",
            currentValue: String(config.consolidation.pruning_confidence_threshold > 0),
            values: ["true", "false"],
          },
        ];

        await ctx.ui.custom((tui, theme, _kb, done) => {
          const headerText = `🧠 pi-memory  (${memCount} mem, ${obsCount} obs, ${pendingExt} pending)`;
          const container = new Container();
          container.addChild(new (class {
            render(_width: number) {
              return [theme.fg("accent", theme.bold(headerText)), ""];
            }
            invalidate() {}
          })());

          const settingsList = new SettingsList(
            items,
            Math.min(items.length + 2, 15),
            getSettingsListTheme(),
            (id, newValue) => {
              const enable = newValue === "true";
              switch (id) {
                case "vector":
                  saveConfigToDisk({ retrieval: { vector_enabled: enable } } as Partial<PiMemoryConfig>);
                  break;
                case "llm":
                  saveConfigToDisk({ llm_extraction: { enabled: enable } } as Partial<PiMemoryConfig>);
                  break;
                case "reranker":
                  saveConfigToDisk({ retrieval: { reranker_enabled: enable } } as Partial<PiMemoryConfig>);
                  break;
                case "decay":
                  saveConfigToDisk({ consolidation: { decay_enabled: enable } } as Partial<PiMemoryConfig>);
                  break;
                case "pruning":
                  saveConfigToDisk({
                    consolidation: {
                      pruning_confidence_threshold: enable ? 0.1 : 0,
                      pruning_age_days: 30,
                    },
                  } as Partial<PiMemoryConfig>);
                  break;
              }
              ctx.ui.notify(`Memory ${id}: ${enable}. Run /reload to apply.`, "info");
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
      } catch {
        ctx.ui.notify("Failed to load TUI components for interactive mode.", "error");
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
