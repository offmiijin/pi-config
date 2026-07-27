# CAPTURE — Detalhes de Implementação

## Objetivo

Capturar toda interação relevante do agente como "observação bruta" (raw observation) para alimentar o pipeline de memória. Fire-and-forget — nunca bloqueia o agente.

## Eventos

### Primário: `tool_result`

Dispara após CADA tool call completar. É o ponto de captura com mais informação: sabemos qual tool, com quais argumentos, qual resultado, se deu erro.

```typescript
pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input, event.content, event.isError, event.details

  // Filtro de trivialidade: ignora tools que só leem, não agem
  if (isTrivialToolCall(event)) return;

  const obs: RawObservation = {
    id: crypto.randomUUID(),
    sessionId: ctx.sessionManager.getSessionId(),
    projectId: deriveProjectId(ctx.cwd),
    timestamp: Date.now(),
    type: "tool_result",
    toolName: event.toolName,
    input: summarizeInput(event.input),
    outcome: event.isError ? "error" : "success",
    contentPreview: truncateOutput(event.content, 2000),
    errorPreview: event.isError ? truncateOutput(getErrorContent(event), 500) : undefined,
    filePaths: extractFilePaths(event),
    ttl: Date.now() + 7 * 24 * 3600 * 1000, // +7 dias
  };

  // FIRE-AND-FORGET: enfileira, não espera
  observationBuffer.enqueue(obs);
});
```

### Filtro de Trivialidade

```typescript
const TRIVIAL_TOOLS = ["read", "ls", "find"];

function isTrivialToolCall(event: ToolResultEvent): boolean {
  if (!TRIVIAL_TOOLS.includes(event.toolName)) return false; // bash, write, edit → sempre captura

  // read/ls/find: só captura se teve erro ou output relevante
  if (event.isError) return false; // erro em read/ls/find é relevante
  if (event.toolName === "read" && isLargeOrImportantRead(event)) return false;
  if (event.toolName === "find" && event.details?.matchCount > 10) return false;

  return true; // read trivial, ls de diretório comum, find com poucos resultados → ignora
}

function isLargeOrImportantRead(event: ToolResultEvent): boolean {
  const content = extractTextContent(event.content);
  if (!content) return false;
  // Arquivos grandes (>10KB) provavelmente são importantes
  if (content.length > 10_000) return true;
  // Arquivos de configuração/documentação sempre importam
  const importantPatterns = [
    /package\.json/,
    /tsconfig\.json/,
    /Dockerfile/,
    /docker-compose/,
    /\.github\/workflows/,
    /README\.md/,
    /\.env/,
  ];
  return importantPatterns.some(p => p.test(event.input?.path ?? ""));
}
```

### Sumarização de Input

```typescript
function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  // Preserva estrutura mas trunca valores longos
  const summarized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 500) {
      summarized[key] = value.slice(0, 500) + "...";
    } else if (Array.isArray(value) && value.length > 10) {
      summarized[key] = `[${value.length} items]`;
    } else {
      summarized[key] = value;
    }
  }
  return summarized;
}
```

### Extração de File Paths

```typescript
function extractFilePaths(event: ToolResultEvent): string[] {
  const paths: string[] = [];

  // Do input
  if (typeof event.input?.path === "string") paths.push(event.input.path);
  if (typeof event.input?.filePath === "string") paths.push(event.input.filePath);
  if (Array.isArray(event.input?.paths)) paths.push(...event.input.paths);

  // De edits
  if (Array.isArray(event.input?.edits)) {
    for (const edit of event.input.edits) {
      if (typeof edit.path === "string") paths.push(edit.path);
    }
  }

  // Do output (bash: extrair paths de comandos git, npm, etc.)
  if (event.toolName === "bash" && typeof event.input?.command === "string") {
    const gitPaths = extractGitPaths(event.input.command);
    paths.push(...gitPaths);
  }

  return [...new Set(paths)]; // dedup
}
```

### Secundário: `before_agent_start`

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const obs: RawObservation = {
    id: crypto.randomUUID(),
    sessionId: ctx.sessionManager.getSessionId(),
    projectId: deriveProjectId(ctx.cwd),
    timestamp: Date.now(),
    type: "user_prompt",
    contentPreview: event.prompt.slice(0, 500),
    outcome: "success",
    ttl: Date.now() + 7 * 24 * 3600 * 1000,
  };
  observationBuffer.enqueue(obs);
});
```

### Terciário: `session_shutdown`

```typescript
pi.on("session_shutdown", async (_event, ctx) => {
  // Flush final — escreve tudo que está no buffer
  await observationBuffer.flush();
  // Dispara sweep de consolidação (se houver volume suficiente)
  if (observationBuffer.getStats().pendingExtraction > 50) {
    await sweepConsolidator.run();
  }
});
```

## Observation Buffer

Buffer em memória que acumula observações e faz flush periódico para storage.

```typescript
class ObservationBuffer {
  private buffer: RawObservation[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL = 10_000; // 10 segundos
  private readonly MAX_BUFFER_SIZE = 100;

  constructor(private storage: IStorage) {}

  enqueue(obs: RawObservation): void {
    this.buffer.push(obs);

    // Flush se buffer cheio
    if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
      this.flush(); // fire-and-forget
    }

    // Garante timer de flush periódico
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_INTERVAL);
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    await this.storage.insertObservations(batch);

    // Aplica N1 (dedup) inline — ver CONSOLIDATE.md
    for (const obs of batch) {
      await consolidationN1.processObservation(obs);
    }

    this.clearTimer();
  }

  getStats() {
    return {
      buffered: this.buffer.length,
      pendingExtraction: this.buffer.filter(o => o.type === "tool_result" && o.outcome !== "trivial").length,
    };
  }

  private clearTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
```

## Project ID

Derivado deterministicamente do git root ou cwd:

```typescript
function deriveProjectId(cwd: string): string {
  // Tenta git root
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", { cwd }).toString().trim();
    return crypto.createHash("sha256").update(gitRoot).digest("hex").slice(0, 12);
  } catch {
    // Fallback: hash do cwd
    return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  }
}
```

## Métricas de Captura

Expostas via `memory_status`:

```
Captures: 156 total
  By type: tool_result=145, user_prompt=11
  By tool: bash=67, write=34, edit=28, grep=12, read=4
  Buffered: 3 pending flush
  Trivial filtered: 234 (read=200, ls=30, find=4)
```

## Edge Cases

### Tool calls em paralelo
- `tool_result` handlers podem intercalar (ordem de completion ≠ ordem de source)
- observationBuffer é thread-safe (operações síncronas em Node single-thread, mas flush é async)
- IDs únicos (UUID) garantem não-duplicação

### Session fork
- Observações da session original são herdadas pelo fork (já estão no storage)
- Nova session tem novo sessionId — observações pós-fork têm sessionId diferente
- ProjectId permanece o mesmo

### Compaction
- Observações de turnos compactados são perdidas (não estão mais no session JSONL)
- Mas já foram capturadas e persistidas ANTES do compaction
- `session_before_compact`: força flush do buffer para não perder dados

### Erro no storage durante flush
- Buffer mantém as observações (não foram removidas em caso de erro)
- Retry no próximo flush (10s depois)
- Se 3 retries falharem: log de erro, descarta batch (evita memory leak no buffer)
