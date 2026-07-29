/**
 * slugify — Converte texto em filenames seguros para sistema de arquivos.
 *
 * Usado para gerar paths de páginas markdown a partir de títulos.
 * Cross-runtime: Bun e Node.js (usa .normalize('NFD') disponível em ambos).
 */

// ── Slugify texto ──────────────────────────────────────────────────────

/**
 * Converte texto em filename seguro.
 *
 * Regras:
 *   1. Lowercase
 *   2. Remove acentos (NFD + regex)
 *   3. Replace não alfanumérico por hífen
 *   4. Trim hífens das bordas
 *   5. Limit 80 chars
 *
 * @param text - Texto livre
 * @returns Slug seguro para filename
 */
export function slugify(text: string): string {
  if (!text) return "untitled";

  let slug = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 80);

  if (!slug) return "untitled";
  return slug;
}

// ── Slugify path completo ──────────────────────────────────────────────

/**
 * Gera path completo para uma página a partir do tipo e título.
 *
 * @param type - Tipo da página (decision, preference, etc)
 * @param title - Título da página
 * @returns Path no formato "tipo/titulo-slugificado.md"
 */
export function slugifyPath(type: string, title: string): string {
  const slug = slugify(title);
  return `${type}s/${slug}.md`; // "decisions/foo.md", "lessons/bar.md"
}

/**
 * Pluraliza um tipo para nome de diretório.
 *
 * decision → decisions
 * preference → preferences
 * lesson → lessons
 * pattern → patterns
 * fact → facts
 * session → sessions
 */
export function typeToDir(type: string): string {
  const map: Record<string, string> = {
    decision: "decisions",
    preference: "preferences",
    lesson: "lessons",
    pattern: "patterns",
    fact: "facts",
    session: "sessions",
  };
  return map[type] ?? `${type}s`;
}

/**
 * Gera path completo usando o tipo como diretório.
 *
 * @param type - Tipo da página
 * @param title - Título
 * @returns Path no formato "tipo-plural/titulo.md"
 */
export function slugifyPathByType(type: string, title: string): string {
  const dir = typeToDir(type);
  const slug = slugify(title);
  return `${dir}/${slug}.md`;
}

// ── Resolução de conflitos de path ─────────────────────────────────────

/**
 * Resolve path único: se o path já existe, append sufixo numérico.
 *
 * "decisions/foo.md" + ["decisions/foo.md"] → "decisions/foo-2.md"
 * "decisions/foo.md" + ["decisions/foo.md", "decisions/foo-2.md"] → "decisions/foo-3.md"
 *
 * @param basePath - Path desejado (ex: "decisions/foo.md")
 * @param existingPaths - Set ou array de paths existentes
 * @returns Path único com sufixo se necessário
 */
export function resolveUniquePath(
  basePath: string,
  existingPaths: Set<string> | string[],
): string {
  const set = existingPaths instanceof Set ? existingPaths : new Set(existingPaths);

  if (!set.has(basePath)) return basePath;

  const ext = pathExt(basePath);
  const base = basePath.slice(0, -ext.length);
  let counter = 2;

  while (set.has(`${base}-${counter}${ext}`)) {
    counter++;
  }

  return `${base}-${counter}${ext}`;
}

/** Extrai extensão de arquivo incluindo o ponto. */
function pathExt(p: string): string {
  const idx = p.lastIndexOf(".");
  return idx >= 0 ? p.slice(idx) : "";
}
