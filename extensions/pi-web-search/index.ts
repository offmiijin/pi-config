/**
 * Web Search Extension — Entry Point
 *
 * Registers:
 *   - /web_search command (configure API keys)
 *   - web_search tool (SearXNG → Tavily → Exa → Serper.dev cascade)
 *   - web_fetch tool
 *   - web_agent tool (research orchestrator)
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getWebSearchArgumentCompletions } from "./command-completions";
import { search, isSearxngReachable, validateProvider } from "./search";
import { fetchPages } from "./fetch";
import { registerWebAgent } from "./agent";
import {
	installRenderer,
	isRendererInstallationInProgress,
	validateRendererInstallation,
} from "./renderer-install";
import { closeSharedRendererClient } from "./renderer-client";
import {
	getConfigSummary,
	setKey,
	setRendererMode,
	getConfiguredProviders,
	getSearxngUrl,
	getSearxngKey,
} from "./config";

export default function (pi: ExtensionAPI) {
	// O pi-sandbox cria um worktree após o ctx.cwd original já ter sido
	// definido. web_fetch precisa gravar no workspace efetivo da sessão para
	// que read/ls possam acessar os arquivos dentro do mesmo namespace.
	let sandboxWorkspaceCwd: string | undefined;
	pi.events?.on("custom:dev-sandbox-session", (event: { workspaceCwd?: string }) => {
		sandboxWorkspaceCwd = event.workspaceCwd;
	});
	pi.events?.on("custom:dev-sandbox-session-shutdown", () => {
		sandboxWorkspaceCwd = undefined;
		closeSharedRendererClient();
	});
	pi.on("session_shutdown", async () => {
		closeSharedRendererClient();
	});

	// Aviso de startup — 1x por processo, só quando nada está funcionando
	let startupNotified = false;
	pi.on("session_start", async (_event, ctx) => {
		if (startupNotified) return;
		startupNotified = true;

		const configured = getConfiguredProviders();
		if (configured.length > 0) {
			// Algo configurado — só alerta se SearXNG configurado mas offline
			const searxngConfigured = getSearxngUrl() !== null || getSearxngKey() !== null;
			if (searxngConfigured && !(await isSearxngReachable()) && ctx.hasUI) {
				ctx.ui.notify(
					"⚠️ SearXNG configurado mas não responde (Docker parado?). A cascata usará Tavily/Exa/Serper.",
					"warning",
				);
			}
			return;
		}

		// Nada configurado — SearXNG local responde? então está tudo bem
		if (await isSearxngReachable()) return;
		if (ctx.hasUI) {
			ctx.ui.notify(
				"🌐 Nenhum provedor de busca configurado.\n" +
					"  • API gratuita: /web_search config <tavily|exa|serper> <key>\n" +
					"  • SearXNG local: docker compose up -d em extensions/pi-web-search",
				"warning",
			);
		}
	});

	// ── Command: /web_search ───────────────────────────────────────────
	pi.registerCommand("web_search", {
		description:
			"Configure search providers and the optional JavaScript renderer. Examples:\n" +
			"  /web_search                         → show current keys\n" +
			"  /web_search config                  → interactive setup (pick provider, enter key)\n" +
			"  /web_search config serper <key>     → save Serper.dev key directly\n" +
			"  /web_search config exa <key>        → save Exa key directly\n" +
			"  /web_search config tavily <key>     → save Tavily key directly\n" +
			"  /web_search config searxng <key>    → save SearXNG key directly\n" +
			"  /web_search config searxng-url <url>→ set custom SearXNG URL (default: http://localhost:4000)\n" +
			"  /web_search help                    → show all configuration commands\n" +
			"  /web_search config renderer install → install optional Python + Playwright renderer\n" +
			"  /web_search config renderer status  → validate renderer installation\n" +
			"  /web_search config renderer <auto|never|required> → set renderer mode\n" +
			"Providers: serper (2.5k/mo free), exa (1k/mo free), tavily (1k/mo free), searxng (local, free)",
		getArgumentCompletions: getWebSearchArgumentCompletions,
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/);

			// /web_search — show status; /web_search help — show the same help explicitly
			if (parts.length === 0 || parts[0] === "" || parts[0] === "help") {
				ctx.ui.notify(getConfigSummary(), "info");
				return;
			}

			// /web_search config ...
			if (parts[0] === "config") {
				// Renderer é uma configuração local, não uma chave de provider.
				if (parts[1] === "renderer") {
					const action = parts[2];
					if (action === "install") {
						if (isRendererInstallationInProgress()) {
							ctx.ui.notify("⚠️ Uma instalação do renderer já está em andamento.", "warning");
							return;
						}
						ctx.ui.notify(
							"⏳ Instalação do renderer iniciada. Python, Playwright e Chromium serão configurados.",
							"info",
						);
						ctx.ui.setStatus("pi-web-search-renderer", "Instalando renderer Python + Playwright…");
						try {
							const result = await installRenderer(ctx.signal, (chunk) => {
								const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
								const lastLine = lines.at(-1);
								if (lastLine) {
									ctx.ui.setStatus(
										"pi-web-search-renderer",
										`Instalando renderer: ${lastLine.slice(-120)}`,
									);
								}
							});
							if (!result.ok) {
								ctx.ui.notify(
									`❌ Falha ao instalar o renderer.\n${result.output.trim().slice(-2000)}`,
									"error",
								);
								return;
							}

							ctx.ui.setStatus("pi-web-search-renderer", "Validando Playwright, Chromium e protocolo JSONL…");
							const validation = await validateRendererInstallation(result.command);
							if (!validation.ok) {
								ctx.ui.notify(
									`⚠️ Instalação concluída, mas a validação falhou: ${validation.error}`,
									"warning",
								);
								return;
							}

							ctx.ui.notify(
								`✅ Renderer instalado e validado: ${result.command}`,
								"info",
						);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							ctx.ui.notify(`❌ Falha ao instalar o renderer: ${message}`, "error");
						} finally {
							ctx.ui.setStatus("pi-web-search-renderer", undefined);
						}
						return;
					}
					if (action === "status") {
						if (isRendererInstallationInProgress()) {
							ctx.ui.notify("⏳ A instalação do renderer ainda está em andamento.", "info");
							return;
						}
						ctx.ui.setStatus("pi-web-search-renderer", "Validando renderer…");
						try {
							const validation = await validateRendererInstallation();
							ctx.ui.notify(
								validation.ok
									? "✅ Renderer instalado e validado (Playwright + Chromium + JSONL)."
									: `❌ Renderer indisponível: ${validation.error}`,
								validation.ok ? "info" : "error",
							);
						} finally {
							ctx.ui.setStatus("pi-web-search-renderer", undefined);
						}
						return;
					}
					if (action === "auto" || action === "never" || action === "required") {
						if (isRendererInstallationInProgress()) {
							ctx.ui.notify("⚠️ Aguarde a instalação do renderer terminar antes de alterar o modo.", "warning");
							return;
						}
						setRendererMode(action);
						ctx.ui.notify(`✅ Renderer configurado como ${action}.`, "info");
						return;
					}
					ctx.ui.notify(
						"Uso: /web_search config renderer <install|status|auto|never|required>",
						"error",
					);
					return;
				}

				// /web_search config <provider> <key> — direct
				if (parts.length >= 3) {
					const [, provider, ...rest] = parts;
					const key = rest.join(" ");
					try {
						setKey(provider, key.trim());
						const validation = await validateProvider(provider);
						const configured = getConfiguredProviders();
						ctx.ui.notify(
							validation.ok
								? `✅ ${provider} key salva e validada (${validation.detail}).\nConfigured: ${configured.join(", ") || "none"}`
								: `⚠️ ${provider} key salva, mas validação falhou: ${validation.detail}\nConfigured: ${configured.join(", ") || "none"}`,
							validation.ok ? "info" : "warning",
						);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`❌ ${msg}`, "error");
					}
					return;
				}

				// /web_search config — interactive setup
				if (!ctx.hasUI) {
					ctx.ui.notify(
						"Usage: /web_search config <serper|exa|tavily|searxng> <key>\n" +
						"Or set env vars: SERPER_API_KEY, EXA_API_KEY, TAVILY_API_KEY, SEARXNG_KEY",
						"info",
					);
					return;
				}

				const provider = await ctx.ui.select(
					"Select search provider to configure:",
					["serper (2.5k/mo free)", "exa (1k/mo free)", "tavily (1k/mo free)", "searxng (local, free)"],
				);
				if (!provider) return;
				// Extract provider name from label (text before first space)
				const providerName = provider.split(/\s/)[0];

				const key = await ctx.ui.input(
					`Enter API key for ${providerName}:`,
					"",
				);
				if (!key || !key.trim()) {
					ctx.ui.notify("❌ No key provided. Cancelled.", "error");
					return;
				}

				try {
					setKey(providerName, key.trim());
					const validation = await validateProvider(providerName);
					const configured = getConfiguredProviders();
					ctx.ui.notify(
						validation.ok
							? `✅ ${providerName} key salva e validada (${validation.detail}).\nConfigured: ${configured.join(", ") || "none"}`
							: `⚠️ ${providerName} key salva, mas validação falhou: ${validation.detail}\nConfigured: ${configured.join(", ") || "none"}`,
						validation.ok ? "info" : "warning",
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`❘ ${msg}`, "error");
				}
				return;
			}

			// Unknown subcommand — show help
			const configured = getConfiguredProviders();
			ctx.ui.notify(
				`Unknown subcommand: ${parts[0]}\n\n` +
				`Usage: /web_search config [<provider> <key>]\n` +
				`Providers: serper, exa, tavily, searxng\n` +
				`Configured: ${configured.join(", ") || "none"}`,
				"error",
			);
		},
	});

	// ── Tool: web_search ───────────────────────────────────────────────
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via SearXNG (local) → Tavily → Exa → Serper.dev API cascade. " +
			"Returns up to 10 results (title, URL only — no content). " +
			"After collecting URLs, call web_fetch to get full page content. " +
			"Configure API keys via /web_search config <provider> <key> or env vars. " +
			"Call multiple times with different queries to gather diverse sources.",

		parameters: Type.Object({
			query: Type.String({
				description: "Search query — use specific, targeted terms for better results",
			}),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { query } = params as { query: string };

			const output = await search(query, signal ?? undefined);

			const lines: string[] = [];

			if (output.results.length === 0) {
				lines.push(`## 🔍 Results for "${query}" (failed)`);
				lines.push("");
				lines.push(output.error ?? "No results returned.");
				lines.push("");
				lines.push("Suggestions:");
				lines.push("- Start SearXNG: 'docker compose up -d' in the extension directory");
				lines.push("- Configure an API key: /web_search config <serper|exa|tavily|searxng> <key>");
				lines.push("- Or set env vars: SERPER_API_KEY, EXA_API_KEY, TAVILY_API_KEY, SEARXNG_KEY");
				lines.push("- Try a different query with more specific terms");

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { query: output.query, source: output.source, results: [], error: output.error },
				};
			}

			lines.push(`## 🔍 Results for "${query}" (${output.source})`);
			lines.push("");

			if (output.error) {
				lines.push(`> Note: ${output.error}`);
				lines.push("");
			}

			for (const [i, r] of output.results.entries()) {
				lines.push(`${i + 1}. **${r.title}**`);
				lines.push(`   URL: ${r.url}`);
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					query: output.query,
					source: output.source,
					results: output.results,
					error: output.error,
				},
			};
		},
	});

	// ── Tool: web_agent (research orchestrator) ───────────────────────
	registerWebAgent(pi);

	// ── Tool: web_fetch ───────────────────────────────────────────────
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch full page content from a list of URLs. " +
			"Converts each page's HTML to Markdown (.md) and saves to " +
			".sandbox-cache/fetch/page_<id>/. " +
			"Pages that appear to be SPAs can optionally be rendered with the local Python + Playwright renderer. " +
			"Non-text content (PDF, images, archives, ...) is downloaded as-is to the same dir. " +
			"Processes up to 10 URLs in parallel; excess URLs are queued. " +
			"Each request uses a random User-Agent and a small random delay to avoid blocking. " +
			"Call after web_search to get the actual content of the URLs found.",

		parameters: Type.Object({
			urls: Type.Array(Type.String(), {
				description:
					"URLs to fetch — pass all collected URLs in one call. " +
					"Max 10 concurrent, rest queued automatically.",
			}),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const { urls } = params as { urls: string[] };

			if (!urls || urls.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`## 🔍 web_fetch — no URLs provided\n\n` +
								`Pass at least one URL in the \`urls\` parameter.`,
						},
					],
					details: {},
				};
			}

			const cwd = sandboxWorkspaceCwd ?? (_ctx as any)?.cwd ?? process.cwd();
			// Escopa a saída por sessão do pi: um único dir por sessão
			const sessionKey = (_ctx as any)?.sessionManager?.getSessionId?.() ?? "default";

			let output;
			try {
				output = await fetchPages(urls, cwd, signal ?? undefined, undefined, sessionKey);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text:
								`## 🔍 web_fetch — failed\n\n` +
								`Could not start fetch operation.\n` +
								`Error: ${msg}`,
						},
					],
					details: { error: msg },
				};
			}

			const lines: string[] = [];

			if (output.succeeded === 0 && output.failed > 0) {
				lines.push(`## 🔍 web_fetch — all ${output.total} URLs failed`);
				lines.push("");
				lines.push("Every URL returned an error. This may indicate:");
				lines.push("- Network connectivity issues");
				lines.push("- The target sites are blocking automated requests");
				lines.push("- Invalid or expired URLs");
				lines.push("");
			} else {
				lines.push(`Fetched ${output.total} URLs → ${output.outputDir}`);
			}
			lines.push("");

			for (const r of output.results) {
				if (r.file && r.size !== undefined) {
					const sizeKB = (r.size / 1024).toFixed(1);
					const icon = r.binary ? "⬇️" : "✅";
					lines.push(`  ${icon} ${r.file} (${sizeKB} KB)`);
					lines.push(`     ${r.url}`);
					if (r.textFile) {
						lines.push(`     → texto extraído: ${r.textFile} (use \`read\`)`);
					}
					if (r.note) {
						lines.push(`     ⚠ ${r.note}`);
					}
				} else if (r.error) {
					lines.push(`  ❌ ${r.url}`);
					lines.push(`     → ${r.error}`);
				} else {
					lines.push(`  ⚠️  ${r.url} — unknown state`);
				}
			}

			lines.push("");
			lines.push(
				`Summary: ${output.succeeded} succeeded, ${output.failed} failed out of ${output.total}.`,
			);

			if (output.succeeded > 0) {
				lines.push(
					`Use \`read\` to inspect the saved files under ${output.outputDir}/`,
				);
			}

			if (output.binaryDir) {
				lines.push(
					`Binary downloads (PDF/images/...) saved under ${output.binaryDir}/`,
				);
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					outputDir: output.outputDir,
					total: output.total,
					succeeded: output.succeeded,
					failed: output.failed,
					results: output.results,
				},
			};
		},
	});
}
