/**
 * RegexExtractor — N2: Extração inline via regex patterns, custo zero.
 *
 * Roda diretamente no tool_result handler.
 * Aplica patterns pré-definidos ao content_preview/error_preview da observação
 * e retorna ExtractedFact[] para serem persistidos como memórias.
 *
 * ADR-002: Nível 2 — Regex (imediato, inline, <1ms).
 */

import type { RawObservation, ExtractedFact, MemoryType, MemoryScope } from "../types";

// ── Pattern definition ─────────────────────────────────────────────────

interface RegexPattern {
  /** Nome do pattern para métricas/log */
  name: string;
  /** Regex aplicado ao texto combinado da observação */
  regex: RegExp;
  /**
   * Extrai um ExtractedFact a partir do match e do contexto da observação.
   * Retorna null se o match não produzir fato útil.
   */
  extract: (match: RegExpMatchArray, observation: RawObservation) => ExtractedFact | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Trunca texto para caber em um fato */
function truncate(text: string, maxLen = 300): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/** Limpa whitespace e normaliza texto extraído */
function cleanMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Monta texto combinado da observação para scan */
function getScanText(obs: RawObservation): string {
  const parts: string[] = [];
  if (obs.content_preview) parts.push(obs.content_preview);
  if (obs.error_preview) parts.push(obs.error_preview);
  // Inclui comando bash se disponível via input_json
  if (obs.input_json) {
    try {
      const input = JSON.parse(obs.input_json);
      if (typeof input["command"] === "string") parts.push(input["command"]);
    } catch {
      // ignora
    }
  }
  return parts.join("\n");
}

// ── Patterns — ADR-002 + EXTRACT.md ────────────────────────────────────

const PATTERNS: RegexPattern[] = [
  // ══════════════════════════════════════════════════════════════════
  // 1. Test/Build Failures
  // ══════════════════════════════════════════════════════════════════
  {
    name: "test_failure",
    regex:
      /(?:Tests?|Specs?|Suites?)\s*(?::|—|-)\s*(\d+)\s*failed[,\s]*(\d+)\s*passed/i,
    extract: (match, obs) => {
      const failed = parseInt(match[1] ?? "0", 10);
      if (failed === 0) return null;
      const affectedFile =
        obs.file_paths.find((p) => /\.(spec|test)\.\w+$/.test(p)) ??
        obs.file_paths[0] ??
        "unknown";
      return {
        text: `Test failure: ${failed} test(s) failed in ${affectedFile}`,
        type: "lesson" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#test", "#failure"],
        confidence: 0.7,
        source_observation_ids: [obs.id],
      };
    },
  },

  {
    name: "build_failure",
    regex:
      /(?:Build|Compil(?:ation|e)|Bundl(?:e|ing))\s*(?:failed|error|falhou)/i,
    extract: (_match, obs) => ({
      text: `Build failure: ${obs.tool_name} failed${obs.file_paths.length ? ` (${obs.file_paths.join(", ")})` : ""}`,
      type: "lesson" as MemoryType,
      scope: "project" as MemoryScope,
      tags: ["#build", "#failure"],
      confidence: 0.7,
      source_observation_ids: [obs.id],
    }),
  },

  {
    name: "lint_error",
    regex:
      /(?:ESLint|Prettier|TSLint|Biome)\s*.*?(?:error|warning)s?\s*:\s*(\d+)/i,
    extract: (match) => ({
      text: `Lint issues: ${match[1]} error(s)/warning(s) detected`,
      type: "fact" as MemoryType,
      scope: "project" as MemoryScope,
      tags: ["#lint", "#quality"],
      confidence: 0.65,
      source_observation_ids: [],
    }),
  },

  // ══════════════════════════════════════════════════════════════════
  // 2. Dependency Changes
  // ══════════════════════════════════════════════════════════════════
  {
    name: "dependency_added",
    regex:
      /(?:added|installed|adicionad[oa])\s+(?:\d+\s+)?(?:package|dependency|dependência)s?\s*[.:]?\s*(.+)/i,
    extract: (match) => {
      const pkg = cleanMatch(match[1] ?? "unknown");
      return {
        text: `Added dependency: ${truncate(pkg, 250)}`,
        type: "fact" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#dependencies", "#added"],
        confidence: 0.75,
        source_observation_ids: [],
      };
    },
  },

  {
    name: "dependency_removed",
    regex:
      /(?:removed|uninstalled|removid[oa])\s+(?:\d+\s+)?(?:package|dependency|dependência)s?\s*[.:]?\s*(.+)/i,
    extract: (match) => {
      const pkg = cleanMatch(match[1] ?? "unknown");
      return {
        text: `Removed dependency: ${truncate(pkg, 250)}`,
        type: "fact" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#dependencies", "#removed"],
        confidence: 0.75,
        source_observation_ids: [],
      };
    },
  },

  {
    name: "dependency_updated",
    regex:
      /(?:updated|upgraded|downgraded|atualizad[oa])\s+(?:\d+\s+)?(?:package|dependency|dependência)s?\s*[.:]?\s*(.+)/i,
    extract: (match) => {
      const pkg = cleanMatch(match[1] ?? "unknown");
      return {
        text: `Updated dependency: ${truncate(pkg, 250)}`,
        type: "fact" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#dependencies", "#updated"],
        confidence: 0.75,
        source_observation_ids: [],
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // 3. Git Actions
  // ══════════════════════════════════════════════════════════════════
  {
    name: "git_commit",
    regex:
      /\[(\S+)\s+([0-9a-f]{7,})\]\s+(.+)/i,
    extract: (match) => {
      const branch = match[1] ?? "?";
      const sha = (match[2] ?? "???????").slice(0, 7);
      const msg = cleanMatch(match[3] ?? "");
      return {
        text: `Git commit [${branch} ${sha}]: ${truncate(msg, 250)}`,
        type: "fact" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#git", "#commit"],
        confidence: 0.85,
        source_observation_ids: [],
      };
    },
  },

  {
    name: "git_action_generic",
    regex:
      /\bgit\s+(commit|push|merge|rebase|checkout|branch|switch|restore)\b/i,
    extract: (match) => {
      const action = match[1].toLowerCase();
      return {
        text: `Git ${action} executed`,
        type: "fact" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#git"],
        confidence: 0.9,
        source_observation_ids: [],
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // 4. Runtime Errors / Stack Traces
  // ══════════════════════════════════════════════════════════════════
  {
    name: "stack_trace",
    regex:
      /(?:Error|Exception|TypeError|ReferenceError|SyntaxError|RangeError)(?::\s*|\s+)(.+?)(?:\n|\||$)/i,
    extract: (match) => {
      const msg = cleanMatch(match[1] ?? "unknown error");
      return {
        text: `Runtime error: ${truncate(msg, 250)}`,
        type: "lesson" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#error", "#runtime"],
        confidence: 0.8,
        source_observation_ids: [],
      };
    },
  },

  {
    name: "file_location_error",
    regex:
      /\bat\s+(?:\S+\s+)?\(?(\S+):(\d+):(\d+)\)?/i,
    extract: (match) => {
      const file = match[1] ?? "?";
      const line = match[2] ?? "?";
      // Pula se "file" capturado não parece path (ex: capturou nome de função)
      if (!/\.\w+/.test(file) && !file.includes("/")) return null;
      return {
        text: `Error location: ${file}:${line}`,
        type: "lesson" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#error", "#location"],
        confidence: 0.75,
        source_observation_ids: [],
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // 5. Preference Declarations
  // ══════════════════════════════════════════════════════════════════
  {
    name: "preference_explicit",
    regex:
      /\b(?:pref(?:er|ira|iro)|recomend[ao]|sugiro)\s+(?:usar|utilizar|escrever|fazer|manter|criar)\s+(.+?)(?:[.;]|$|\n)/i,
    extract: (match) => {
      const pref = cleanMatch(match[1] ?? match[0]);
      return {
        text: `Preference: ${truncate(pref, 250)}`,
        type: "preference" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#preference"],
        confidence: 0.55, // Baixa — regex pode capturar falsos positivos
        source_observation_ids: [],
      };
    },
  },

  {
    name: "always_never_rule",
    regex:
      /\b(?:always|sempre|nunca|never|evite|avoid)\s+(?:use|usar|utilize|utilizar|using|faça|fazer|escreva|escrever)\s+(.+?)(?:[.;]|$|\n)/i,
    extract: (match) => {
      const rule = cleanMatch(match[0]);
      return {
        text: `Rule: ${truncate(rule, 250)}`,
        type: "pattern" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#rule", "#convention"],
        confidence: 0.55,
        source_observation_ids: [],
      };
    },
  },

  {
    name: "uses_tool",
    regex:
      /\b(?:usa|usam|utiliza|utilizam|uses?|using)\s+(?:pnpm|npm|yarn|bun|docker|kubernetes|k8s|vite|webpack|esbuild|tsc|jest|vitest|mocha|cypress|playwright)\b/i,
    extract: (match) => {
      const tool = match[0].split(/\s+/).pop()?.toLowerCase() ?? match[0];
      return {
        text: `Uses ${tool} as tool/dependency`,
        type: "preference" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#tool", `#${tool}`],
        confidence: 0.6,
        source_observation_ids: [],
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // 6. File Operations
  // ══════════════════════════════════════════════════════════════════
  {
    name: "file_created",
    regex:
      /(?:created?|criou|criad[oa]|written?|wrote)\s+(?:file|arquivo)?\s*[`"]?(\S+\.\w+)[`"]?/i,
    extract: (match) => {
      const file = match[1] ?? "unknown";
      return {
        text: `File created: ${file}`,
        type: "fact" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#file", "#created"],
        confidence: 0.7,
        source_observation_ids: [],
      };
    },
  },

  {
    name: "file_deleted",
    regex:
      /(?:deleted?|removed?|deletou|removeu|apagou)\s+(?:file|arquivo)?\s*[`"]?(\S+\.\w+)[`"]?/i,
    extract: (match) => {
      const file = match[1] ?? "unknown";
      return {
        text: `File deleted: ${file}`,
        type: "fact" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#file", "#deleted"],
        confidence: 0.7,
        source_observation_ids: [],
      };
    },
  },

  {
    name: "file_modified",
    regex:
      /(?:modified|updated|changed|alterad[oa]|atualizad[oa])\s+(?:file|arquivo)?\s*[`"]?(\S+\.\w+)[`"]?/i,
    extract: (match) => {
      const file = match[1] ?? "unknown";
      return {
        text: `File modified: ${file}`,
        type: "fact" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#file", "#modified"],
        confidence: 0.7,
        source_observation_ids: [],
      };
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // 7. Configuration Changes
  // ══════════════════════════════════════════════════════════════════
  {
    name: "config_change",
    regex:
      /(?:\.env|config(?:uration)?|settings?|\.json|\.yaml|\.yml|\.toml|tsconfig|package\.json)\s*.*?(?:changed|modif(?:ied|icad[oa])|alterad[oa]|atualizad[oa]|updated)/i,
    extract: (_match, obs) => ({
      text: `Configuration changed via ${obs.tool_name}${obs.file_paths.length ? `: ${obs.file_paths.join(", ")}` : ""}`,
      type: "fact" as MemoryType,
      scope: "project" as MemoryScope,
      tags: ["#config", "#changed"],
      confidence: 0.65,
      source_observation_ids: [obs.id],
    }),
  },

  // ══════════════════════════════════════════════════════════════════
  // 8. Tool-specific fatal errors (bash non-zero exit)
  // ══════════════════════════════════════════════════════════════════
  {
    name: "bash_error",
    regex: /command\s+failed\s+with\s+exit\s+code\s+(\d+)/i,
    extract: (match, obs) => {
      const code = match[1] ?? "?";
      // Tenta extrair o comando do input_json
      let cmd = obs.tool_name ?? "unknown";
      if (obs.input_json) {
        try {
          const input = JSON.parse(obs.input_json);
          if (typeof input["command"] === "string") {
            cmd = input["command"].split("\n")[0].slice(0, 100);
          }
        } catch {
          // ignora
        }
      }
      return {
        text: `Command failed (exit ${code}): ${truncate(cmd, 200)}`,
        type: "lesson" as MemoryType,
        scope: "project" as MemoryScope,
        tags: ["#error", "#bash"],
        confidence: 0.8,
        source_observation_ids: [obs.id],
      };
    },
  },
];

// ── RegexExtractor ─────────────────────────────────────────────────────

export class RegexExtractor {
  private patterns: RegexPattern[];

  constructor() {
    this.patterns = PATTERNS;
  }

  /**
   * Aplica todos os patterns à observação e retorna fatos extraídos.
   *
   * Cada pattern pode produzir 0 ou 1 fato (primeiro match vence por pattern).
   * Patterns diferentes podem ambos produzir fatos (não são mutualmente exclusivos).
   *
   * @param observation - RawObservation do tool_result
   * @returns Fatos extraídos (pode ser array vazio)
   */
  extract(observation: RawObservation): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    const text = getScanText(observation);

    if (!text || text.length < 10) return facts;

    for (const pattern of this.patterns) {
      // Reseta lastIndex para regex com flag g
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(text);
      if (match) {
        const fact = pattern.extract(match, observation);
        if (fact) {
          // Preenche source_observation_ids se vazio
          if (fact.source_observation_ids.length === 0) {
            fact.source_observation_ids = [observation.id];
          }
          facts.push(fact);
        }
      }
    }

    return facts;
  }
}
