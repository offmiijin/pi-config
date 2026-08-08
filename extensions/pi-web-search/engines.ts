/**
 * Web Search Extension — Engine Barrel
 *
 * Four engines: SearXNG (local, self-hosted) → Tavily → Exa → Serper.dev
 * SearXNG is tried first since it's free, local, and has no rate limits.
 */

export type { SearchResult, EngineResult } from "./engines/types";

export { createAbortController } from "./engines/types";

export { searchSearxng } from "./engines/searxng";
export { searchTavily } from "./engines/tavily";
export { searchExa } from "./engines/exa";
export { searchSerper } from "./engines/serper";
