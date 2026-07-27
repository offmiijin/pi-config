# EXTRACT — Detalhes de Implementação

## Objetivo

Transformar observações brutas (ruído) em fatos semânticos estruturados (conhecimento). Pipeline de 3 níveis: Regex (N2, custo zero) → LLM barato (N3, background) → Entity Resolution + KG (N4, futuro).

## Nível 2: Regex Extractor

### Arquitetura

Roda inline no `tool_result` handler. Aplica patterns de regex pré-definidos. Custo: <1ms por observação.

```typescript
interface RegexPattern {
  name: string;
  regex: RegExp;
  extract: (match: RegExpMatchArray, obs: RawObservation) => ExtractedFact | null;
}

interface ExtractedFact {
  text: string;
  type: MemoryType;          // "preference" | "decision" | "lesson" | "fact" | "pattern"
  confidence: number;        // 0.0 - 1.0
  tags: string[];
  source: "regex";
}
```

### Patterns Implementados

```typescript
const PATTERNS: RegexPattern[] = [
  // ── Test/Build Failures ──
  {
    name: "test_failure",
    regex: /(?:FAIL|ERROR|failed|error)\s+.*?(\S+\.(?:spec|test)\.\w+)/i,
    extract: (match, obs) => ({
      text: `Teste ${obs.outcome === "error" ? "falhou" : "teve erro"}: ${match[1]}`,
      type: "lesson",
      confidence: 0.7,
      tags: ["#test", "#failure"],
      source: "regex",
    }),
  },

  // ── Dependency Changes ──
  {
    name: "dependency_change",
    regex: /(?:install|add|remove|update)\s+(?:--save-?(?:dev)?\s+)?(\S+@?\S*)/i,
    extract: (match) => ({
      text: `Dependência modificada: ${match[1]}`,
      type: "fact",
      confidence: 0.8,
      tags: ["#dependency"],
      source: "regex",
    }),
  },

  // ── Git Actions ──
  {
    name: "git_action",
    regex: /git\s+(commit|push|merge|rebase|checkout|branch)\s+.*?(?:\n|$)/i,
    extract: (match, obs) => ({
      text: `Git: ${match[0].trim()}`,
      type: "fact",
      confidence: 0.9,
      tags: ["#git"],
      source: "regex",
    }),
  },

  // ── Stack Traces ──
  {
    name: "stack_trace",
    regex: /(?:Error|Exception|TypeError|ReferenceError):\s*(.+?)(?:\n|$)/i,
    extract: (match, obs) => ({
      text: `Erro em runtime: ${match[1]}`,
      type: "lesson",
      confidence: 0.85,
      tags: ["#error", "#runtime"],
      source: "regex",
    }),
  },

  // ── Declared Preferences ──
  {
    name: "preference",
    regex: /(?:pref(?:er|ira)|use|sempre\s+(?:use|usa)|nunca\s+(?:use|usa)|always|never)\s+(.+?)(?:\.|$|\n)/i,
    extract: (match, obs) => ({
      text: `Preferência: ${match[0].trim()}`,
      type: "preference",
      confidence: 0.6, // mais baixa — regex pode capturar falsos positivos
      tags: ["#preference"],
      source: "regex",
    }),
  },

  // ── File Creation/Deletion ──
  {
    name: "file_creation",
    regex: /(?:created?|criou|criado)\s+(?:file|arquivo)?\s*(\S+\.\w+)/i,
    extract: (match) => ({
      text: `Arquivo criado: ${match[1]}`,
      type: "fact",
      confidence: 0.8,
      tags: ["#file"],
      source: "regex",
    }),
  },

  // ── Configuration Changes ──
  {
    name: "config_change",
    regex: /(?:\.env|config|settings?)\s*.*?(?:changed|modif|alterad|atualiz)/i,
    extract: (match, obs) => ({
      text: `Configuração alterada: ${obs.toolName} em ${obs.filePaths?.join(", ") ?? "desconhecido"}`,
      type: "fact",
      confidence: 0.7,
      tags: ["#config"],
      source: "regex",
    }),
  },
];
```

### Integração

```typescript
// Em capture/hooks.ts
pi.on("tool_result", async (event, ctx) => {
  // ... criar RawObservation ...

  // N2: regex extraction (inline, <1ms)
  const content = extractTextContent(event.content);
  if (content) {
    for (const pattern of PATTERNS) {
      const match = content.match(pattern.regex);
      if (match) {
        const fact = pattern.extract(match, obs);
        if (fact) {
          // Enfileira para storage (passa pelo N1 dedup)
          await storage.insertMemory(fromExtractedFact(fact, obs));
          obs.extractedN2 = true;
        }
      }
    }
  }

  // ... enfileirar no buffer ...
});
```

## Nível 3: LLM Extractor

### Arquitetura

Roda em background, após `turn_end` de turnos "ricos". Fire-and-forget. Usa modelo barato (gpt-4o-mini) para extrair fatos de múltiplas observações de uma vez.

```typescript
class LlmExtractor {
  private pendingObservations: RawObservation[] = [];
  private extractionTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 10;
  private readonly MAX_WAIT_MS = 30_000; // 30 segundos

  constructor(
    private storage: IStorage,
    private llmClient: LlmClient,
  ) {}

  enqueue(observations: RawObservation[]): void {
    // Filtra: só observações não extraídas pelo N2 e com conteúdo suficiente
    const candidates = observations.filter(o =>
      !o.extractedN2 &&
      o.contentPreview &&
      o.contentPreview.length > 50
    );
    this.pendingObservations.push(...candidates);

    if (this.pendingObservations.length >= this.BATCH_SIZE) {
      this.extract();
    } else if (!this.extractionTimer) {
      this.extractionTimer = setTimeout(() => this.extract(), this.MAX_WAIT_MS);
    }
  }

  private async extract(): Promise<void> {
    if (this.pendingObservations.length === 0) return;

    const batch = this.pendingObservations.splice(0, this.BATCH_SIZE);
    this.clearTimer();

    try {
      const prompt = this.buildExtractionPrompt(batch);
      const response = await this.llmClient.complete(prompt, { timeout: 5000 });
      const facts = this.parseExtractionResponse(response);

      for (const fact of facts) {
        const memory = fromExtractedFact(fact, batch[0]); // usa metadata do primeiro
        await this.storage.insertMemory(memory); // passa pelo N1
      }

      // Marca observações como extraídas
      for (const obs of batch) {
        obs.extractedN3 = true;
        await this.storage.updateObservation(obs.id, { extracted: 1 });
      }
    } catch (error) {
      // Re-enfileira para retry (máx 3 tentativas)
      if (batch[0].retryCount < 3) {
        batch.forEach(o => o.retryCount = (o.retryCount ?? 0) + 1);
        this.pendingObservations.push(...batch);
      } else {
        // Desiste após 3 falhas — marca como extraídas para não bloquear sweep
        for (const obs of batch) {
          await this.storage.updateObservation(obs.id, { extracted: 1, extractionError: String(error) });
        }
      }
    }
  }

  private buildExtractionPrompt(observations: RawObservation[]): string {
    const interactions = observations.map((obs, i) => {
      const parts = [`### Interaction ${i + 1}`];
      parts.push(`Tool: ${obs.toolName}`);
      parts.push(`Outcome: ${obs.outcome}`);
      if (obs.contentPreview) parts.push(`Output: ${obs.contentPreview.slice(0, 500)}`);
      if (obs.errorPreview) parts.push(`Error: ${obs.errorPreview}`);
      if (obs.filePaths?.length) parts.push(`Files: ${obs.filePaths.join(", ")}`);
      return parts.join("\n");
    }).join("\n\n");

    return `You are extracting structured knowledge from a coding agent's interactions.

Below are ${observations.length} interactions between a coding agent and its tools.
Extract atomic, self-contained facts. Each fact must be understandable without context.

${interactions}

Return a JSON array of facts:
[
  {
    "text": "self-contained fact statement",
    "type": "fact | preference | decision | lesson | pattern",
    "confidence": 0.0-1.0,
    "tags": ["#tag1", "#tag2"]
  }
]

Rules:
- IGNORE trivial output: file listings, successful npm install, standard build output
- IGNORE stack traces longer than 50 lines (summarize instead)
- PREFERENCES: "uses pnpm", "prefers functional style", "always writes tests"
- DECISIONS: "chose hexagonal architecture", "decided to use PostgreSQL"
- LESSONS: "test X fails with Node 22", "don't use feature Y because of bug Z"
- FACTS: "project has 3 services", "deploy uses ArgoCD"
- PATTERNS: "all routes follow /api/v1/ prefix", "error handling uses Either monad"
- Each fact MUST be self-contained. "Fixed the bug" is NOT acceptable.
  "Fixed bug in auth.spec.ts where login timeout was set to 100ms instead of 5000ms" IS acceptable.
- confidence: 0.9+ for explicit statements, 0.5-0.7 for inferred facts
- Return ONLY the JSON array, no other text.`;
  }

  private parseExtractionResponse(response: string): ExtractedFact[] {
    try {
      // Tenta parse direto
      return JSON.parse(response);
    } catch {
      // Tenta extrair JSON de dentro de markdown code block
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) return JSON.parse(jsonMatch[1]);

      // Tenta extrair array JSON
      const arrayMatch = response.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (arrayMatch) return JSON.parse(arrayMatch[0]);

      throw new Error("Could not parse LLM extraction response");
    }
  }

  private clearTimer() {
    if (this.extractionTimer) {
      clearTimeout(this.extractionTimer);
      this.extractionTimer = null;
    }
  }
}
```

### Trigger de Extração N3

```typescript
pi.on("turn_end", async (event, ctx) => {
  // Verifica se turno foi "rico"
  const toolResults = event.toolResults ?? [];
  const hasAction = toolResults.some(tr =>
    ["bash", "write", "edit", "grep"].includes(tr.toolName)
  );

  if (!hasAction) return;

  // Coleta observações deste turno que ainda não foram extraídas
  const turnObservations = observationBuffer
    .getRecent(toolResults.map(tr => tr.toolCallId));

  if (turnObservations.length > 0) {
    llmExtractor.enqueue(turnObservations);
  }
});
```

### Configuração LLM

```typescript
interface LlmExtractorConfig {
  enabled: boolean;          // feature flag (default: true)
  provider: string;          // "openai" | "anthropic" | "local"
  model: string;             // default: "gpt-4o-mini"
  maxTokens: number;         // default: 1000
  temperature: number;       // default: 0.1 (baixa criatividade)
  batchSize: number;         // default: 10
  maxWaitMs: number;         // default: 30000
  maxRetries: number;        // default: 3
}
```

## Nível 4: Entity Resolution + Knowledge Graph

### Status: FUTURO (Fase 4)

Implementação planejada mas não iniciada. Ver ADR-002-N4 no ADR.md para justificativa do adiamento.

### Pré-requisitos para N4

1. **Entity Recognizer (NER):** Usar `@xenova/transformers` com modelo NER (ex: `Xenova/bert-base-NER`) ou GLiNER.
2. **Entity Resolver:** Fuzzy matching (Levenshtein) + embedding similarity. LLM como fallback para casos ambíguos.
3. **Relation Extractor:** LLM-based. Prompt especializado para relações de código.
4. **Temporal Grounder:** Módulo separado. Cada relação ganha `valid_from`/`valid_until`.
5. **Graph Store:** KuzuDB (embedded, zero config, compativel com o principio zero-deps) ou Neo4j.

### Esboço de schema do grafo (não implementado)

```cypher
CREATE NODE TABLE Person(name STRING, PRIMARY KEY(name));
CREATE NODE TABLE Project(name STRING, PRIMARY KEY(name));
CREATE NODE TABLE File(path STRING, PRIMARY KEY(path));
CREATE NODE TABLE Service(name STRING, PRIMARY KEY(name));

CREATE REL TABLE LEADS(FROM Person TO Project, valid_from INT64, valid_until INT64);
CREATE REL TABLE MEMBER_OF(FROM Person TO Project, valid_from INT64, valid_until INT64);
CREATE REL TABLE DEPENDS_ON(FROM Service TO Service, valid_from INT64);
CREATE REL TABLE DEPLOYED_VIA(FROM Service TO Service, valid_from INT64);
CREATE REL TABLE IMPORTS(FROM File TO File);
CREATE REL TABLE OWNS(FROM Person TO File);
```

## Métricas de Extração

```
Extractions (N2 regex): 89
  By pattern: test_failure=15, dependency_change=23, git_action=18,
              preference=8, file_creation=12, config_change=13
  Accuracy: ~85% (avaliado por amostragem)

Extractions (N3 LLM): 12 batches
  Avg batch size: 8.3 observations
  Avg facts per batch: 4.7
  Avg latency: 1.2s
  Failures: 1 (retry succeeded)
  Cost: ~$0.002 total (gpt-4o-mini)
```

## Edge Cases

### Observação muito longa
- Regex: opera sobre os primeiros 2000 chars (contentPreview)
- LLM: prompt limita cada observação a 500 chars de output

### LLM alucina fatos
- Confidence baixa (0.5-0.7) para fatos inferidos
- N1 (dedup) detecta duplicatas e aumenta confidence gradualmente
- Fatos com confidence < 0.3 são candidatos a pruning no sweep

### Extração concorrente
- Apenas uma extração N3 ativa por vez (lock simples)
- Observações enfileiradas durante extração ativa aguardam próximo batch

### Modelo LLM indisponível
- Fallback: observações permanecem não extraídas
- Sweep N2 tentará novamente
- Se API key não configurada: N3 é desabilitado automaticamente
