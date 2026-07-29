/**
 * wiki — Módulo de gerenciamento do wiki markdown.
 *
 * Responsável pela fonte da verdade: arquivos .md com frontmatter.
 * SQLite é o índice derivado, wiki é a fonte.
 *
 * Módulos:
 *   - slugify.ts: Converte títulos em filenames
 *   - frontmatter.ts: Parse e build de frontmatter YAML
 *   - writer.ts: Escrita atômica, deleção, leitura
 */

export { slugify, slugifyPath, slugifyPathByType, resolveUniquePath, typeToDir } from "./slugify";
export type { Frontmatter, PageType, PageScope, PageStatus } from "./frontmatter";
export {
  parseFrontmatter,
  buildFrontmatter,
  validateFrontmatter,
} from "./frontmatter";
export { WikiWriter } from "./writer";
export type { WikiWriterConfig } from "./writer";
