# INJECT — Detalhes de Implementação

## Objetivo

Entregar as memórias recuperadas ao agente no momento certo e no formato certo: antes do LLM começar a raciocinar, com o mínimo de tokens, máximo de relevância, e sem invalidar o KV cache do provider.

Três componentes: KV Cache-Stable Snapshot (injeção automática), Memory Gateway (judge de suficiência), `memory_search` tool (agência do modelo).

---

## Componente 1: KV Cache-Stable Snapshot

### O Problema

```
SEM SNAPSHOT (ingênuo):
  Turno 1: system_prompt = "...base..." + "[memória atualizada a cada turno]"
  Turno 2: system_prompt = "...base..." + "[memória diferente!]"
    → Provider detecta que o system_prompt MUDOU
    → Invalida TODO o KV cache
    → Reprocessa system_prompt + todo histórico
    → Custo: input tokens * 2 (pagou de novo pelo system_prompt)

COM SNAPSHOT:
  Turno 1: system_prompt = "...base..." + "[SNAPSHOT: bytes fixos]"
  Turno 2: system_prompt = "...base..." + "[SNAPSHOT: MESMOS bytes]"
  Turno 3: system_prompt = "...base..." + "[SNAPSHOT: MESMOS bytes]"
    → Provider detecta: system_prompt É IDÊNTICO
    → KV cache HIT
    → Só processa mensagens novas
    → Custo: input tokens * 0.3 (cache read é 90% mais barato!)
```

### Implementação

```typescript
class CacheStableInjector {
  private snapshot: string | null = null;
  private snapshotDirty = true;
  private snapshotTimestamp = 0;
  private turnCountSinceSnapshot = 0;
  private lastDate: string | null = null;

  constructor(
    private storage: IStorage,
    private retriever: HybridRetriever,
    private config: InjectConfig,
  ) {}

  // ── Checkpoints de Invalidação ──

  markDirty(reason: string): void {
    this.snapshotDirty = true;
    console.log(`Memory snapshot invalidated: ${reason}`);
  }

  onSessionStart(): void {
    this.markDirty("session_start");
  }

  onSessionCompact(): void {
    // Handoff capturado antes do compact
    this.markDirty("session_compact");
  }

  onLongTermWrite(): void {
    this.markDirty("long_term_write");
  }

  onDayRollover(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastDate !== today) {
      this.markDirty("day_rollover");
      this.lastDate = today;
    }
  }

  // ── Hot Path: chamado em TODO before_agent_start ──

  async getMemoryBlock(userPrompt: string): Promise<string> {
    // Verifica day rollover
    this.onDayRollover();

    // Se snapshot está limpo, reusa
    if (!this.snapshotDirty && this.snapshot) {
      this.turnCountSinceSnapshot++;
      return this.snapshot;
    }

    // Reconstrói snapshot
    this.snapshot = await this.buildMemoryBlock(userPrompt);
    this.snapshotDirty = false;
    this.snapshotTimestamp = Date.now();
    this.turnCountSinceSnapshot = 0;

    return this.snapshot;
  }

  private async buildMemoryBlock(userPrompt: string): Promise<string> {
    const parts: string[] = [];
    let totalBytes = 0;
    const MAX_TOTAL_BYTES = 16 * 1024; // 16KB (~4K tokens)

    // ── 1. Scratchpad (até 2KB) — sempre incluído ──
    const scratchpad = this.loadScratchpad();
    if (scratchpad) {
      const truncated = this.truncateBytes(scratchpad, 2048);
      parts.push(`## Scratchpad\n${truncated}`);
      totalBytes += truncated.length;
    }

    // ── 2. Persistent Memories (até 4KB) — core ──
    const memories = await this.retriever.search(userPrompt, "current_project", 10);
    if (memories.length > 0) {
      const memoryLines = memories.map(m =>
        `- [${m.type}] ${m.text}`
      );
      const memoryBlock = memoryLines.join("\n");
      const truncated = this.middleTruncate(memoryBlock, 4096);
      parts.push(`## Persistent Memory\n${truncated}`);
      totalBytes += truncated.length;
    }

    // ── 3. Daily Log (hoje, até 3KB, tail) ──
    const todayLog = this.loadDailyLog(new Date());
    if (todayLog && totalBytes < MAX_TOTAL_BYTES) {
      const truncated = this.tail(todayLog, Math.min(3072, MAX_TOTAL_BYTES - totalBytes));
      parts.push(`## Today\n${truncated}`);
      totalBytes += truncated.length;
    }

    // ── 4. Daily Log (ontem, até 3KB, tail) — menor prioridade ──
    if (totalBytes < MAX_TOTAL_BYTES) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayLog = this.loadDailyLog(yesterday);
      if (yesterdayLog) {
        const truncated = this.tail(yesterdayLog, Math.min(3072, MAX_TOTAL_BYTES - totalBytes));
        parts.push(`## Yesterday\n${truncated}`);
      }
    }

    return parts.join("\n\n");
  }

  // ── Truncation Helpers ──

  private truncateBytes(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf-8");
    if (buf.length <= maxBytes) return text;
    return buf.slice(0, maxBytes).toString("utf-8");
  }

  private tail(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf-8");
    if (buf.length <= maxBytes) return text;
    return "...\n" + buf.slice(buf.length - maxBytes).toString("utf-8");
  }

  private middleTruncate(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf-8");
    if (buf.length <= maxBytes) return text;

    // Mantém começo e fim, remove meio
    const headSize = Math.floor(maxBytes * 0.7);
    const tailSize = maxBytes - headSize;
    const head = buf.slice(0, headSize).toString("utf-8");
    const tail = buf.slice(buf.length - tailSize).toString("utf-8");
    return `${head}\n... [${buf.length - maxBytes} bytes truncated] ...\n${tail}`;
  }

  // ── File Loaders ──

  private loadScratchpad(): string | null {
    try {
      return readFileSync(this.scratchpadPath, "utf-8");
    } catch {
      return null;
    }
  }

  private loadDailyLog(date: Date): string | null {
    const dateStr = date.toISOString().slice(0, 10);
    try {
      return readFileSync(join(this.dailyDir, `${dateStr}.md`), "utf-8");
    } catch {
      return null;
    }
  }

  // ── Metrics ──

  getStats() {
    return {
      dirty: this.snapshotDirty,
      age: Date.now() - this.snapshotTimestamp,
      turnsSinceSnapshot: this.turnCountSinceSnapshot,
      snapshotSize: this.snapshot?.length ?? 0,
    };
  }
}
```

### Integração no before_agent_start

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // Verifica se deve pular injeção
  if (config.inject.snapshot.enabled === false) return;

  const memoryBlock = await cacheStableInjector.getMemoryBlock(event.prompt);

  if (!memoryBlock) return; // nada para injetar

  // Adiciona ao system prompt
  return {
    systemPrompt: event.systemPrompt
      + `\n\n---\n## Agent Memory (auto-injected, ${new Date().toISOString()})\n\n`
      + memoryBlock
      + `\n\n---\n`,
  };
});
```

---

## Componente 2: Memory Gateway (Judge)

### Arquitetura

O Gateway decide se as memórias recuperadas são suficientes para responder o prompt sem que o agente precise inspecionar o repositório.

```
User prompt: "como fazer deploy do gateway?"

1. RETRIEVE: busca top-10 memórias com o prompt como query
   → encontra: runbook de deploy do gateway (score: 0.94)

2. JUDGE: avalia suficiência
   → top score > 0.9 E ≥3 resultados → confiança ALTA
   → suficiência: "KNOWN_ANSWER"

3. INJECT:
   Se "KNOWN_ANSWER":
     Injeta: "## Known Answer\n[runbook completo do deploy]"
     Instrui: "DO NOT re-explore the repo. Use this knowledge."
   Se "PRIOR_KNOWLEDGE":
     Injeta: "## Prior Knowledge\n[...]"
     Instrui: "Verify with repo inspection if unsure."
   Se "NO_MEMORY":
     Não injeta nada. Deixa LLM explorar normalmente.
```

### Implementação (Judge Heurístico — v1)

```typescript
type GatewayDecision = "KNOWN_ANSWER" | "PRIOR_KNOWLEDGE" | "NO_MEMORY";

interface GatewayResult {
  decision: GatewayDecision;
  confidence: number;
  memories: ScoredMemory[];
  reason: string;
}

class MemoryGateway {
  constructor(private config: GatewayConfig) {}

  async evaluate(
    prompt: string,
    memories: ScoredMemory[],
  ): Promise<GatewayResult> {
    // Sem memórias → sem injeção
    if (memories.length === 0) {
      return {
        decision: "NO_MEMORY",
        confidence: 1.0,
        memories: [],
        reason: "No relevant memories found",
      };
    }

    const topScore = memories[0].score;
    const avgScore = this.average(memories.map(m => m.score));
    const count = memories.length;

    // Regra 1: Top score muito alto + múltiplos resultados
    if (topScore > 0.9 && count >= 3 && avgScore > 0.7) {
      return {
        decision: "KNOWN_ANSWER",
        confidence: topScore,
        memories,
        reason: `High confidence match: ${count} memories, top score ${topScore.toFixed(2)}`,
      };
    }

    // Regra 2: Top score alto
    if (topScore > 0.8) {
      return {
        decision: "PRIOR_KNOWLEDGE",
        confidence: topScore,
        memories,
        reason: `Good match: top score ${topScore.toFixed(2)}`,
      };
    }

    // Regra 3: Score médio
    if (topScore > 0.6 && count >= 2) {
      return {
        decision: "PRIOR_KNOWLEDGE",
        confidence: topScore * 0.7, // penaliza
        memories: memories.slice(0, 5),
        reason: `Moderate match: ${count} memories, verify with caution`,
      };
    }

    // Regra 4: Score baixo ou poucos resultados
    return {
      decision: "NO_MEMORY",
      confidence: topScore,
      memories: [],
      reason: count === 1
        ? `Only 1 weak match (score ${topScore.toFixed(2)})`
        : `No strong matches (top score ${topScore.toFixed(2)})`,
    };
  }

  private average(nums: number[]): number {
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
}
```

### Judge com Metadata (v2)

Adiciona fatores de penalização:

```typescript
async evaluateWithMetadata(
  prompt: string,
  memories: ScoredMemory[],
): Promise<GatewayResult> {
  const base = await this.evaluate(prompt, memories);
  if (base.decision === "NO_MEMORY") return base;

  let confidence = base.confidence;

  // Penalidade por idade
  const maxAge = Math.max(
    ...memories.map(m => Date.now() - (m.lastAccessed ?? m.timestamp))
  );
  const daysSinceAccess = maxAge / (24 * 3600 * 1000);

  if (daysSinceAccess > 30) {
    confidence *= 0.5;
    base.reason += `; data is ${Math.floor(daysSinceAccess)}d old (-50%)`;
  } else if (daysSinceAccess > 7) {
    confidence *= 0.7;
    base.reason += `; data is ${Math.floor(daysSinceAccess)}d old (-30%)`;
  }

  // Penalidade por contradições
  if (this.detectContradictions(memories.slice(0, 5))) {
    confidence *= 0.5;
    base.reason += "; contradictions detected (-50%)";
  }

  // Penalidade por baixa confiança nas fontes
  const avgSourceConfidence = this.average(
    memories.map(m => m.confidence ?? 0.5)
  );
  if (avgSourceConfidence < 0.6) {
    confidence *= 0.8;
    base.reason += "; low source confidence (-20%)";
  }

  // Reavalia decisão
  if (confidence < 0.6) {
    return { ...base, decision: "NO_MEMORY", confidence };
  }
  if (confidence < 0.8) {
    return { ...base, decision: "PRIOR_KNOWLEDGE", confidence };
  }
  return { ...base, confidence };
}

private detectContradictions(memories: ScoredMemory[]): boolean {
  // Simplificado: verifica se há preferências conflitantes
  const preferences = memories.filter(m => m.type === "preference");
  const topics = new Map<string, string[]>();

  for (const pref of preferences) {
    const topic = this.extractTopic(pref.text);
    if (!topic) continue;
    if (!topics.has(topic)) topics.set(topic, []);
    topics.get(topic)!.push(pref.text);
  }

  for (const [, texts] of topics) {
    if (texts.length >= 2) {
      // Verifica se textos dizem coisas diferentes sobre o mesmo tópico
      const unique = new Set(texts.map(t => t.toLowerCase()));
      if (unique.size > 1) return true;
    }
  }

  return false;
}

private extractTopic(text: string): string | null {
  // Extrai assunto principal: "preferência: usar pnpm" → "package-manager"
  const match = text.match(/(?:usa|usar|prefere|package manager|framework|language)\s*:?\s*(\w+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}
```

### Integração com CacheStableInjector

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // 1. Busca memórias
  const memories = await retriever.search(event.prompt, projectId, 10);

  // 2. Gateway decide
  const gatewayResult = await gateway.evaluateWithMetadata(event.prompt, memories);

  // 3. Injeta conforme decisão
  let memoryBlock = "";

  switch (gatewayResult.decision) {
    case "KNOWN_ANSWER":
      memoryBlock = this.formatKnownAnswer(gatewayResult);
      break;
    case "PRIOR_KNOWLEDGE":
      memoryBlock = this.formatPriorKnowledge(gatewayResult);
      break;
    case "NO_MEMORY":
      return; // não injeta nada
  }

  return {
    systemPrompt: event.systemPrompt + "\n\n" + memoryBlock,
  };
});

function formatKnownAnswer(result: GatewayResult): string {
  const memoryItems = result.memories
    .map(m => `- [${m.type}] ${m.text}`)
    .join("\n");

  return [
    "## 🧠 Known Answer (auto-injected)",
    "",
    "The following persisted knowledge likely answers the user's question.",
    "**Use this knowledge directly. DO NOT re-explore the repository**",
    "unless the user explicitly asks for verification or the knowledge seems outdated.",
    "",
    memoryItems,
    "",
    `Confidence: ${(result.confidence * 100).toFixed(0)}%`,
    `Source: agent memory (${result.memories.length} memories)`,
  ].join("\n");
}

function formatPriorKnowledge(result: GatewayResult): string {
  const memoryItems = result.memories.slice(0, 5)
    .map(m => `- [${m.type}] ${m.text}`)
    .join("\n");

  return [
    "## 🧠 Prior Knowledge (auto-injected)",
    "",
    "The following persisted knowledge may help answer the user's question.",
    "**Use this as context. Verify with repo inspection if unsure.**",
    "If the knowledge conflicts with current code, explain the mismatch.",
    "",
    memoryItems,
    "",
    `Confidence: ${(result.confidence * 100).toFixed(0)}%`,
    `Source: agent memory (${result.memories.length} memories)`,
  ].join("\n");
}
```

---

## Componente 3: `memory_search` Tool

### Registro da Tool

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "memory_search",
  label: "Memory Search",
  description:
    "Search persistent memory across all past sessions. " +
    "Use this when the auto-injected context is insufficient " +
    "and you need to recall specific facts, decisions, or preferences.",
  promptSnippet: "Search persistent memory across sessions",
  promptGuidelines: [
    "Use memory_search when the user asks about past decisions, " +
    "project conventions, or things discussed in previous sessions " +
    "that were not auto-injected.",
    "memory_search returns facts from ALL past sessions, " +
    "not just the current one.",
  ],
  parameters: Type.Object({
    query: Type.String({
      description: "What to search for. Use specific terms, not full sentences.",
    }),
    type: Type.Optional(
      StringEnum(["preference", "decision", "lesson", "fact", "pattern"] as const)
    ),
    scope: Type.Optional(
      StringEnum(["project", "user", "global"] as const)
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 20, default: 10 })
    ),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const projectId = deriveProjectId(ctx.cwd);
    const topK = params.limit ?? 10;

    // Busca com filtros
    let results = await retriever.search(params.query, projectId, topK * 2);

    // Filtra por type
    if (params.type) {
      results = results.filter(m => m.type === params.type);
    }

    // Filtra por scope
    if (params.scope) {
      results = results.filter(m => m.scope === params.scope);
    }

    results = results.slice(0, topK);

    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No memories found for "${params.query}".`,
        }],
        details: { count: 0 },
      };
    }

    // Formata resultados
    const formatted = results
      .map((m, i) =>
        `${i + 1}. [${m.type}] ${m.text}\n` +
        `   confidence: ${(m.confidence ?? 0.5).toFixed(2)} | ` +
        `last accessed: ${new Date(m.lastAccessed ?? m.timestamp).toISOString().slice(0, 10)}`
      )
      .join("\n\n");

    return {
      content: [{
        type: "text",
        text: `Found ${results.length} memories:\n\n${formatted}`,
      }],
      details: {
        count: results.length,
        results: results.map(r => ({
          id: r.id,
          text: r.text,
          type: r.type,
          confidence: r.confidence,
        })),
      },
    };
  },
});
```

---

## Configuração de Injeção

```typescript
interface InjectConfig {
  snapshot: {
    enabled: boolean;           // default: true
    maxTotalBytes: number;      // default: 16 * 1024 (16KB)
    scratchpadMaxBytes: number; // default: 2048
    persistentMaxBytes: number; // default: 4096
    dailyLogMaxBytes: number;   // default: 3072
  };
  gateway: {
    enabled: boolean;           // default: true
    mode: "heuristic" | "metadata" | "llm"; // default: "heuristic"
    knownAnswerThreshold: number;   // default: 0.9
    priorKnowledgeThreshold: number; // default: 0.6
  };
  searchTool: {
    enabled: boolean;           // default: true
    maxResults: number;         // default: 20
  };
}
```

---

## Métricas de Injeção

```
Injection:
  Snapshot: stable (age: 12min, 3 turns since rebuild)
    Snapshot size: 3.2KB
    Cache hits: 3/3 turns (100%)

  Gateway: active (mode: heuristic)
    Decisions:
      KNOWN_ANSWER:    45 (28.8%)
      PRIOR_KNOWLEDGE: 78 (50.0%)
      NO_MEMORY:       33 (21.2%)

  Search tool:
    Calls: 23
    Avg results: 4.7
    Zero results: 3 (13%)

  Impact:
    Avg tokens saved/turn: ~8K (KNOWN_ANSWER evita tool calls)
    Avg tool calls avoided: 4.2 (KNOWN_ANSWER)
```

---

## Edge Cases

### Snapshot muito grande (>16KB)
- Trunca por prioridade: scratchpad → persistent → today → yesterday
- Se persistent não cabe: reduz top-K de 10 para 5
- Se ainda não cabe: middle-truncate com "..." no meio

### Gateway falso positivo (KNOWN_ANSWER mas memória stale)
- LLM é instruído a verificar se detectar código conflitante
- Próximo turno: se usuário corrigir, gera nova memória com confidence alta
- Sistema aprende com o erro (reinforcement negativo no confidence da memória stale)

### KV cache invalidação inevitável
- Modelo trocado (`/model`) → cache zera de qualquer forma
- Compaction → novo contexto → snapshot rebuild
- Day rollover → daily log muda → rebuild
- Fora desses casos: snapshot permanece estável por horas/dias

### memory_search tool abusada
- LLM pode chamar a tool mesmo com contexto injetado
- Custo adicional, mas aceitável (tool call extra vs contexto errado)
- Gateway "KNOWN_ANSWER" reduz probabilidade (instrui LLM a não explorar)
