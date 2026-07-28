# CONSOLIDATE — Detalhes de Implementação

## Objetivo

Evitar "memory rot": o acúmulo de observações brutas e memórias redundantes/contraditórias que degradam a qualidade do retrieval. Pipeline de 3 níveis com custos e latências progressivos.

## Nível 1: Imediato, Custo Zero

Roda inline em todo `insertMemory`. É a primeira linha de defesa contra duplicação.

### Regra 1: Dedup por Hash de Conteúdo

```typescript
import crypto from "node:crypto";

function normalizeForHash(text: string): string {
  return text
    // Remove timestamps variáveis
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, "<TIMESTAMP>")
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    // Remove paths absolutos de home
    .replace(/\/home\/\w+/g, "~")
    .replace(/\/Users\/\w+/g, "~")
    // Normaliza espaços
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function contentHash(text: string): string {
  const normalized = normalizeForHash(text);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

async function dedupByHash(
  newMemory: Memory,
  storage: IStorage,
): Promise<"created" | "updated" | "skipped"> {
  const hash = contentHash(newMemory.text);
  newMemory.contentHash = hash;

  // Busca memória existente com mesmo hash no mesmo projeto
  const existing = await storage.getMemoriesByProject(newMemory.projectId, {
    limit: 1,
    // SQLite: SELECT * FROM memories WHERE project_id = ? AND content_hash = ? AND superseded_by IS NULL
  });

  // Query específica por hash (precisa de método dedicado ou filtro em memória)
  const allMemories = await storage.getAllMemories({ limit: 10000 });
  const duplicate = allMemories.find(
    m => m.projectId === newMemory.projectId
      && m.contentHash === hash
      && !m.supersededBy
  );

  if (duplicate) {
    // Reforça a memória existente
    await storage.updateMemory(duplicate.id, {
      accessCount: (duplicate.accessCount ?? 0) + 1,
      lastAccessed: Date.now(),
      confidence: Math.min(1.0, (duplicate.confidence ?? 0.5) + 0.05),
      // Não atualiza text/timestamp — preserva a original
    });

    // Adiciona source_id da observação que gerou esta duplicata
    const sourceIds = [...(duplicate.sourceIds ?? []), ...(newMemory.sourceIds ?? [])];
    await storage.updateMemory(duplicate.id, { sourceIds });

    return "updated";
  }

  return "created";
}
```

**Exemplo de operação:**

```
Observação: "bash: npm test → FAIL em auth.spec.ts"  (turno 3)
  → hash: "abc123"
  → não existe → CRIA memory_1

Observação: "bash: npm test → FAIL em auth.spec.ts"  (turno 7 — mesmo erro!)
  → hash: "abc123" (idêntico após normalização!)
  → memory_1 existe → confidence += 0.05, accessCount += 1
  → NÃO cria nova. memory_1 agora tem confidence 0.55.
```

### Regra 2: Último Fato Vence (Same Key Replacement)

```typescript
function buildMemoryKey(memory: Memory): string {
  // Chave composta: tipo + escopo + tags normalizadas
  const sortedTags = [...(memory.tags ?? [])]
    .map(t => t.toLowerCase().trim())
    .filter(t => t.startsWith("#"))
    .sort()
    .join(",");
  return `${memory.type}:${memory.scope}:${sortedTags}`;
}

// Patterns que indicam CONTRADIÇÃO (substitui) vs REFORÇO (atualiza)
const CONTRADICTION_PATTERNS: RegExp[] = [
  // Mudança explícita de preferência
  /(?:não\s+(?:usa|usar|precisa|prefere|é|são)\s+mais|no longer|stopped using)/i,
  /(?:mud(?:ou|ei|aram)\s+(?:de|para)|switched?\s+(?:from|to)|changed?\s+(?:from|to))/i,
  /(?:agora\s+(?:usa|prefere|é|são)|now\s+(?:uses?|prefers?|is|are))/i,
  /(?:substitu(?:i|iu|íram)\s+(?:por|com)|replaced?\s+(?:by|with))/i,
  /(?:em\s+vez\s+disso|instead)/i,
  // Correção explícita
  /(?:não,\s+|actually,?\s+|correction:?\s+|sorry,?\s+)/i,
];

function isContradiction(existingText: string, newText: string): boolean {
  // Verifica se o novo texto contém padrões de contradição
  for (const pattern of CONTRADICTION_PATTERNS) {
    if (pattern.test(newText)) return true;
  }

  // Verifica opostos: "usa X" vs "usa Y" onde X ≠ Y
  const extractPreference = (text: string) => {
    const match = text.match(/(?:usa|usar|prefere|preferir|use|uses?|prefers?)\s+(.+?)(?:\.|,|$|\s+em|\s+para|\s+no)/i);
    return match?.[1]?.trim().toLowerCase();
  };

  const existingPref = extractPreference(existingText);
  const newPref = extractPreference(newText);

  if (existingPref && newPref && existingPref !== newPref) {
    return true; // "usa pnpm" vs "usa yarn" → contradição
  }

  return false;
}

async function lastFactWins(
  newMemory: Memory,
  storage: IStorage,
): Promise<"created" | "updated" | "superseded"> {
  const key = buildMemoryKey(newMemory);

  // Busca memória existente com mesma chave
  const allMemories = await storage.getAllMemories({ limit: 10000 });
  const existing = allMemories.find(
    m => buildMemoryKey(m) === key
      && !m.supersededBy
      && m.projectId === newMemory.projectId
  );

  if (!existing) return "created";

  if (isContradiction(existing.text, newMemory.text)) {
    // CONTRADIÇÃO: marca antiga como superseded
    await storage.updateMemory(existing.id, {
      supersededBy: newMemory.id,
      lastAccessed: Date.now(),
    });
    // Nova memória referencia a antiga
    newMemory.sourceIds = [
      ...(newMemory.sourceIds ?? []),
      ...(existing.sourceIds ?? []),
      existing.id,
    ];
    return "superseded";
  }

  // REFORÇO: atualiza existente
  await storage.updateMemory(existing.id, {
    text: newMemory.text, // texto mais recente
    confidence: Math.min(1.0, (existing.confidence ?? 0.5) + 0.1),
    lastAccessed: Date.now(),
    accessCount: (existing.accessCount ?? 0) + 1,
    timestamp: newMemory.timestamp, // atualiza timestamp
  });
  return "updated";
}
```

**Exemplo de operação:**

```
Turno 3: memory_write "preferência: usar pnpm em todos os projetos"
  → key: "preference:global:#preference,#pnpm"
  → não existe → CRIA

Turno 25: memory_write "preferência: usar npm neste projeto"
  → key: "preference:project:#npm,#preference" (scope diferente!)
  → NÃO conflita com a anterior → CRIA (correto!)

Turno 48: memory_write "preferência: usar pnpm em todos os projetos"
  → key: "preference:global:#preference,#pnpm"
  → já existe, texto idêntico → dedupHash detecta → SKIP (reforça)

Turno 72: memory_write "agora prefiro usar yarn em vez de pnpm"
  → key: "preference:global:#preference,#yarn"
  → tags diferentes ("#yarn" vs "#pnpm") → KEY DIFERENTE → CRIA
  → MAS: isContradiction detecta "agora prefiro" + "yarn" vs "pnpm"
  → CORRETO: cria nova, antiga NÃO é superseded (keys diferentes = escopos diferentes)
  → AMBAS coexistem: "usar pnpm" + "agora prefiro yarn"
  → Cabe ao retrieval + reranker decidir qual é mais relevante
```

### Orquestração do N1

```typescript
async function consolidateN1(newMemory: Memory, storage: IStorage): Promise<void> {
  // Passo 1: Dedup por hash
  const hashResult = await dedupByHash(newMemory, storage);
  if (hashResult !== "created") return;

  // Passo 2: Last fact wins
  const keyResult = await lastFactWins(newMemory, storage);
  if (keyResult !== "created") return;

  // Passo 3: Insere nova memória
  await storage.insertMemory(newMemory);

  // Atualiza hot index
  ramIndex?.insert(newMemory);
}
```

---

## Nível 2: Background Sweep

### Arquitetura

Roda periodicamente (a cada 30 min ou a cada 50 novas observações, o que vier primeiro). Executa em microtask/worker — nunca bloqueia o agente.

```typescript
class SweepConsolidator {
  private timer: NodeJS.Timeout | null = null;
  private observationCount = 0;
  private readonly SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 min
  private readonly SWEEP_OBS_THRESHOLD = 50;
  private running = false;

  constructor(
    private storage: IStorage,
    private llmExtractor: LlmExtractor,
    private config: ConsolidateConfig,
  ) {}

  // Chamado a cada nova observação
  onObservation(): void {
    this.observationCount++;

    if (this.observationCount >= this.SWEEP_OBS_THRESHOLD) {
      this.run();
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.run(), this.SWEEP_INTERVAL_MS);
    }
  }

  async run(): Promise<void> {
    if (this.running) return; // evita sweep concorrente
    this.running = true;

    try {
      // 1. Busca observações não extraídas
      const unextracted = await this.storage.getUnextractedObservations(
        "current_project", // project_id
        50, // limit
      );

      if (unextracted.length === 0) {
        this.observationCount = 0;
        return;
      }

      // 2. Agrupa por tool_name
      const grouped = this.groupByTool(unextracted);

      // 3. Para cada grupo com ≥3 observações, extrai fatos
      for (const [toolName, observations] of grouped) {
        if (observations.length < 3) continue;

        const facts = await this.llmExtractor.extractBatch(observations);

        for (const fact of facts) {
          const memory = fromExtractedFact(fact, observations[0]);
          await consolidateN1(memory, this.storage); // passa pelo N1
        }

        // Marca como extraídas
        for (const obs of observations) {
          await this.storage.updateObservation(obs.id, { extracted: 1 });
        }
      }

      // 4. Decay: reduz confidence de memórias antigas
      await this.applyDecay();

      // 5. Pruning: remove memórias com confidence muito baixa
      await this.applyPruning();

      // 6. Limpeza de TTL: remove observações expiradas
      const expired = await this.storage.deleteExpiredObservations();
      if (expired > 0) {
        console.log(`Memory sweep: deleted ${expired} expired observations`);
      }

      this.observationCount = 0;
    } catch (error) {
      console.error("Memory sweep failed:", error);
    } finally {
      this.running = false;
      this.timer = null;
    }
  }

  private async applyDecay(): Promise<void> {
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const memoriesToDecay = await this.storage.getAllMemories({
      filter: m => !m.pinned && (m.lastAccessed ?? m.timestamp) < sevenDaysAgo,
    });

    for (const memory of memoriesToDecay) {
      const newConfidence = Math.max(0, (memory.confidence ?? 0.5) * 0.9);
      await this.storage.updateMemory(memory.id, {
        confidence: newConfidence,
      });
      ramIndex?.update(memory); // sincroniza hot index
    }
  }

  private async applyPruning(): Promise<void> {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
    const memoriesToPrune = await this.storage.getAllMemories({
      filter: m =>
        !m.pinned
        && (m.confidence ?? 0.5) < 0.1
        && (m.lastAccessed ?? m.timestamp) < thirtyDaysAgo,
    });

    for (const memory of memoriesToPrune) {
      // Audit log antes de deletar
      console.log(`Memory prune: [${memory.type}] ${memory.text} (confidence: ${memory.confidence})`);
      await this.storage.deleteMemory(memory.id);
      ramIndex?.remove(memory.id);
    }

    if (memoriesToPrune.length > 0) {
      console.log(`Memory sweep: pruned ${memoriesToPrune.length} low-confidence memories`);
    }
  }

  private groupByTool(observations: RawObservation[]): Map<string, RawObservation[]> {
    const grouped = new Map<string, RawObservation[]>();
    for (const obs of observations) {
      const key = obs.toolName ?? "unknown";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(obs);
    }
    return grouped;
  }
}
```

### Configuração

```typescript
interface ConsolidateConfig {
  sweep: {
    enabled: boolean;           // default: true
    intervalMs: number;         // default: 30 * 60 * 1000 (30 min)
    observationThreshold: number; // default: 50
  };
  decay: {
    enabled: boolean;           // default: true
    staleAfterDays: number;     // default: 7
    decayFactor: number;        // default: 0.9 (multiplica confidence)
  };
  pruning: {
    enabled: boolean;           // default: true
    minConfidence: number;      // default: 0.1
    maxAgeDays: number;         // default: 30
  };
}
```

---

## Nível 3: /memory-dream Command

### Arquitetura

Comando manual (ou agendado) que usa LLM potente para revisão completa de memórias.

```typescript
class DreamConsolidator {
  constructor(
    private storage: IStorage,
    private llmClient: LlmClient, // modelo POTENTE: gpt-4o, claude-sonnet, etc.
  ) {}

  async run(projectId: string): Promise<DreamReport> {
    // 1. Busca TODAS as memórias do projeto
    const allMemories = await this.storage.getMemoriesByProject(projectId);

    if (allMemories.length < 2) {
      return { actions: [], summary: "Not enough memories to consolidate" };
    }

    // 2. Agrupa por similaridade de embedding
    const groups = this.groupBySimilarity(allMemories);

    // 3. Para cada grupo com ≥2 memórias, pede LLM para decidir
    const actions: DreamAction[] = [];

    for (const group of groups) {
      if (group.length < 2) continue;

      const decision = await this.analyzeGroup(group);
      actions.push(...decision.actions);
    }

    // 4. Gera relatório
    return {
      actions,
      summary: this.summarizeActions(actions),
      groupsAnalyzed: groups.length,
      totalMemories: allMemories.length,
    };
  }

  private async analyzeGroup(group: Memory[]): Promise<{ actions: DreamAction[] }> {
    const prompt = `You are a memory consolidation assistant. Review this group of related memories from a coding agent and decide what to do with each.

Memories:
${group.map((m, i) => `${i + 1}. [${m.type}] ${m.text} (confidence: ${m.confidence?.toFixed(2)}, last accessed: ${new Date(m.lastAccessed ?? m.timestamp).toISOString()})`).join("\n")}

For each pair or group, decide one of:
- MERGE: memories are duplicates or say the same thing → combine into one
- RESOLVE: memories contradict each other → pick the most recent/reliable
- KEEP: memories are complementary, both should remain
- DELETE: memory is obsolete, no longer relevant

Return JSON:
{
  "actions": [
    {
      "type": "merge | resolve | keep | delete",
      "targetIds": ["id1", "id2"],
      "result": "consolidated memory text (for merge/resolve)",
      "reason": "why this decision"
    }
  ]
}`;

    const response = await this.llmClient.complete(prompt, { temperature: 0.1 });
    return JSON.parse(response);
  }

  async executeActions(actions: DreamAction[], approvedIds: string[]): Promise<void> {
    for (const action of actions) {
      if (!approvedIds.includes(action.targetIds[0])) continue;

      switch (action.type) {
        case "merge":
          // Cria nova memória consolidada
          await this.storage.insertMemory({
            ...group.find(m => m.id === action.targetIds[0])!,
            id: crypto.randomUUID(),
            text: action.result,
            sourceIds: action.targetIds,
            confidence: Math.max(...action.targetIds.map(id =>
              group.find(m => m.id === id)?.confidence ?? 0.5
            )),
            timestamp: Date.now(),
          });
          // Marca originais como superseded
          for (const id of action.targetIds) {
            await this.storage.updateMemory(id, { supersededBy: "merged" });
            ramIndex?.remove(id);
          }
          break;

        case "resolve":
          // Mantém a escolhida, supersede as outras
          const [winner, ...losers] = action.targetIds;
          for (const id of losers) {
            await this.storage.updateMemory(id, { supersededBy: winner });
            ramIndex?.remove(id);
          }
          break;

        case "delete":
          for (const id of action.targetIds) {
            await this.storage.deleteMemory(id);
            ramIndex?.remove(id);
          }
          break;

        case "keep":
          // Nada a fazer
          break;
      }
    }
  }
}
```

### Comando /memory-dream

```typescript
pi.registerCommand("memory-dream", {
  description: "Consolidate and clean up memories using AI analysis",
  handler: async (args, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.notify("🧠 Analyzing memories...", "info");

    const dream = new DreamConsolidator(storage, llmClient);
    const report = await dream.run(deriveProjectId(ctx.cwd));

    if (report.actions.length === 0) {
      ctx.ui.notify("No consolidation needed — memories are clean!", "info");
      return;
    }

    // Mostra relatório interativo
    const choices = report.actions.map((a, i) =>
      `${i + 1}. [${a.type.toUpperCase()}] ${a.reason}`
    );
    const selection = await ctx.ui.select(
      `Found ${report.actions.length} consolidation opportunities. Approve all?`,
      ["Approve ALL", ...choices, "Cancel"],
    );

    if (selection === "Cancel") return;

    const approvedIds = selection === "Approve ALL"
      ? report.actions.flatMap(a => a.targetIds)
      : [report.actions[choices.indexOf(selection!) - 1].targetIds[0]];

    await dream.executeActions(report.actions, approvedIds);
    ctx.ui.notify(`Consolidated ${approvedIds.length} memories!`, "success");
  },
});
```

---

## Métricas de Consolidação

```
Consolidation N1 (dedup + last-fact-wins):
  Dedup hits:     45 (avoided duplicate memories)
  Key conflicts:   8 (4 superseded, 4 updated)
  New memories:   89 (created)

Consolidation N2 (sweep):
  Last sweep:      12 min ago
  Observations extracted: 23 → 5 memories
  Decayed:         67 memories (avg confidence: 0.73 → 0.66)
  Pruned:           3 memories (confidence < 0.1, age > 30d)
  Expired obs:    156 (TTL exceeded)

Consolidation N3 (dream):
  Last dream:      3 days ago
  Actions:         12 (4 merged, 3 resolved, 2 deleted, 3 kept)
```
