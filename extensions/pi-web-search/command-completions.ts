import type { AutocompleteItem } from "@earendil-works/pi-tui";

const TOP_LEVEL: AutocompleteItem[] = [
	{ value: "config", label: "config", description: "Configure providers and renderer" },
	{ value: "help", label: "help", description: "Show configuration help" },
];

const PROVIDERS: AutocompleteItem[] = [
	{ value: "config serper", label: "config serper", description: "Configure Serper.dev API key" },
	{ value: "config exa", label: "config exa", description: "Configure Exa API key" },
	{ value: "config tavily", label: "config tavily", description: "Configure Tavily API key" },
	{ value: "config searxng", label: "config searxng", description: "Configure SearXNG API key" },
	{ value: "config searxng-url", label: "config searxng-url", description: "Configure SearXNG URL" },
	{ value: "config renderer", label: "config renderer", description: "Configure the local SPA renderer" },
];

const RENDERER_ACTIONS: AutocompleteItem[] = [
	{ value: "config renderer install", label: "config renderer install", description: "Install Python + Playwright + Chromium" },
	{ value: "config renderer status", label: "config renderer status", description: "Validate the renderer installation" },
	{ value: "config renderer auto", label: "config renderer auto", description: "Render detected SPAs when available" },
	{ value: "config renderer never", label: "config renderer never", description: "Disable JavaScript rendering" },
	{ value: "config renderer required", label: "config renderer required", description: "Require the renderer for HTML pages" },
];

/** Sugestões para os argumentos de `/web_search`. */
export function getWebSearchArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const candidates = prefix === "" || !prefix.includes(" ")
		? TOP_LEVEL
		: prefix.startsWith("config renderer")
			? RENDERER_ACTIONS
			: prefix.startsWith("config")
				? PROVIDERS
				: [];
	const filtered = candidates.filter((item) => item.value.startsWith(prefix));
	return filtered.length > 0 ? filtered : null;
}
