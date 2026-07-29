/**
 * frontmatter — Parsing e geração de frontmatter YAML para páginas markdown.
 *
 * Formato: ---\n<yaml>\n---\n<body>
 * YAML subset: key: value, key: [list], booleans, números, strings.
 *
 * Cross-runtime: Bun e Node.js (zero dependências).
 */

// ── Tipos ──────────────────────────────────────────────────────────────

export type PageType = "decision" | "preference" | "lesson" | "pattern" | "fact" | "session";
export type PageScope = "project" | "global";
export type PageStatus = "active" | "superseded" | "draft";

export interface Frontmatter {
  type: PageType;
  scope: PageScope;
  title: string;
  tags: string[];
  confidence: number;
  status: PageStatus;
  pinned: boolean;
  supersedes?: string;
  created: string; // ISO 8601
  updated: string; // ISO 8601
  source_observations?: string[];
}

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULTS: Partial<Frontmatter> = {
  tags: [],
  confidence: 0.5,
  status: "active",
  pinned: false,
};

// ── Validação ──────────────────────────────────────────────────────────

const VALID_TYPES: Set<string> = new Set([
  "decision", "preference", "lesson", "pattern", "fact", "session",
]);

const VALID_SCOPES: Set<string> = new Set(["project", "global"]);
const VALID_STATUSES: Set<string> = new Set(["active", "superseded", "draft"]);

/**
 * Valida e normaliza um objeto bruto em Frontmatter.
 * Aplica defaults, verifica campos obrigatórios.
 *
 * @throws Error se campo obrigatório faltar ou tipo for inválido
 */
export function validateFrontmatter(raw: Record<string, unknown>): Frontmatter {
  const errors: string[] = [];

  // type
  if (!raw["type"] || typeof raw["type"] !== "string") {
    errors.push("type é obrigatório (decision | preference | lesson | pattern | fact | session)");
  } else if (!VALID_TYPES.has(raw["type"] as string)) {
    errors.push(`type inválido: ${raw["type"]}`);
  }

  // scope
  if (!raw["scope"] || typeof raw["scope"] !== "string") {
    errors.push("scope é obrigatório (project | global)");
  } else if (!VALID_SCOPES.has(raw["scope"] as string)) {
    errors.push(`scope inválido: ${raw["scope"]}`);
  }

  // title
  if (!raw["title"] || typeof raw["title"] !== "string" || !(raw["title"] as string).trim()) {
    errors.push("title é obrigatório");
  }

  // tags
  if (raw["tags"] !== undefined && !Array.isArray(raw["tags"])) {
    errors.push("tags deve ser um array de strings");
  }

  // confidence
  if (raw["confidence"] !== undefined) {
    const c = raw["confidence"];
    if (typeof c !== "number" || c < 0 || c > 1) {
      errors.push("confidence deve ser número entre 0 e 1");
    }
  }

  // status
  if (raw["status"] !== undefined) {
    if (typeof raw["status"] !== "string" || !VALID_STATUSES.has(raw["status"] as string)) {
      errors.push(`status inválido: ${raw["status"]}`);
    }
  }

  // created
  if (raw["created"] !== undefined && typeof raw["created"] !== "string") {
    errors.push("created deve ser string ISO 8601");
  }

  // updated
  if (raw["updated"] !== undefined && typeof raw["updated"] !== "string") {
    errors.push("updated deve ser string ISO 8601");
  }

  // supersedes
  if (raw["supersedes"] !== undefined && typeof raw["supersedes"] !== "string") {
    errors.push("supersedes deve ser string (path)");
  }

  // source_observations
  if (raw["source_observations"] !== undefined && !Array.isArray(raw["source_observations"])) {
    errors.push("source_observations deve ser um array de strings");
  }

  if (errors.length > 0) {
    throw new Error(`Frontmatter inválido:\n  ${errors.join("\n  ")}`);
  }

  return {
    type: raw["type"] as PageType,
    scope: raw["scope"] as PageScope,
    title: (raw["title"] as string).trim(),
    tags: (raw["tags"] as string[]) ?? DEFAULTS.tags!,
    confidence: (raw["confidence"] as number) ?? DEFAULTS.confidence!,
    status: (raw["status"] as PageStatus) ?? DEFAULTS.status!,
    pinned: (raw["pinned"] as boolean) ?? DEFAULTS.pinned!,
    supersedes: raw["supersedes"] as string | undefined,
    created: (raw["created"] as string) ?? new Date().toISOString(),
    updated: (raw["updated"] as string) ?? new Date().toISOString(),
    source_observations: raw["source_observations"] as string[] | undefined,
  };
}

// ── Parser YAML (subset) ───────────────────────────────────────────────

/**
 * Parseia bloco YAML simples (subset) e retorna Record.
 *
 * Suporta:
 *   key: value
 *   key: [item1, item2, item3]
 *   key: true | false
 *   key: 123 | 0.85
 *   # comentários
 *   linhas vazias
 *
 * @param yaml - String YAML crua (sem os ---)
 * @returns Objeto chave-valor
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();

    // Pula comentários e linhas vazias
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Procura primeiro ": " (separador YAML)
    const sepIdx = trimmed.indexOf(": ");
    if (sepIdx === -1) continue;

    const key = trimmed.slice(0, sepIdx).trim();
    let value: unknown = trimmed.slice(sepIdx + 2).trim();

    if (!key) continue;

    // Array: [item1, item2]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      value = inner
        ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
        : [];
    }
    // Booleano
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    // Número
    else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
      value = value.includes(".") ? parseFloat(value) : parseInt(value, 10);
    }
    // String (remove aspas se houver)
    else if (typeof value === "string") {
      value = value.replace(/^["']|["']$/g, "");
    }

    result[key] = value;
  }

  return result;
}

/**
 * Extrai bloco frontmatter de um markdown.
 *
 * @param markdown - Conteúdo completo do arquivo .md
 * @returns Frontmatter parseado + body, ou null se não há frontmatter
 */
export function parseFrontmatter(markdown: string): { frontmatter: Frontmatter; body: string } | null {
  // Precisa começar com ---
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return null;
  }

  // Encontra fechamento --- (com ou sem newline depois)
  const closingMatch = markdown.slice(4).match(/^[\s\S]*?\n---(?:\n|$)/);
  if (!closingMatch) return null;

  const closingLen = closingMatch[0].length;
  // O match inclui o \n---\n ou \n---$ no final
  const closingIdx = 4 + closingLen - 1; // posição do último caractere do ---
  const yamlBlock = markdown.slice(4, closingIdx - 3); // tira o \n---
  const body = markdown.slice(closingIdx + 1); // depois do --- + newline ou fim

  const raw = parseSimpleYaml(yamlBlock);
  const frontmatter = validateFrontmatter(raw);

  return { frontmatter, body: body.trimStart() };
}

// ── Builder ────────────────────────────────────────────────────────────

/**
 * Gera bloco YAML de frontmatter a partir de um objeto Frontmatter.
 *
 * @param fm - Frontmatter preenchido
 * @returns String YAML (sem os --- delimitadores)
 */
function buildSimpleYaml(fm: Frontmatter): string {
  const lines: string[] = [];

  lines.push(`type: ${fm.type}`);
  lines.push(`scope: ${fm.scope}`);
  lines.push(`title: ${fm.title}`);

  if (fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.join(", ")}]`);
  }

  lines.push(`confidence: ${fm.confidence}`);
  lines.push(`status: ${fm.status}`);
  lines.push(`pinned: ${String(fm.pinned)}`);
  lines.push(`created: ${fm.created}`);
  lines.push(`updated: ${fm.updated}`);

  if (fm.supersedes) {
    lines.push(`supersedes: ${fm.supersedes}`);
  }

  if (fm.source_observations && fm.source_observations.length > 0) {
    lines.push(`source_observations: [${fm.source_observations.join(", ")}]`);
  }

  return lines.join("\n");
}

/**
 * Constrói um documento markdown completo com frontmatter.
 *
 * @param fm - Frontmatter
 * @param body - Conteúdo markdown (sem frontmatter)
 * @returns String completa: ---\n<yaml>\n---\n<body>
 */
export function buildFrontmatter(fm: Frontmatter, body: string): string {
  const yaml = buildSimpleYaml(fm);
  const bodyClean = body.trimStart();
  return `---\n${yaml}\n---\n${bodyClean}`;
}
