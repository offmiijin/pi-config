/**
 * Agent Type Switcher — alterna entre CODER, PLANNER e WRITER.
 *
 * Cada tipo de agente tem:
 *   - AGENTS.md próprio (injetado no system prompt via before_agent_start)
 *   - Conjunto de tools específico
 *   - Restrição opcional de extensões de arquivo (edit/write só .md)
 *
 * Uso no TUI:
 *   /agent              -> menu interativo
 *   /agent coder        -> modo direto
 *   /agent planner      -> modo direto
 *   /agent writer       -> modo direto
 *
 * Integração com status-bar.ts:
 *   Emite "custom:agent-switch" para atualizar o badge
 *   Persiste estado em session entries (customType: "agent-switcher")
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentConfig as coderConfig } from "./coder.ts";
import { agentConfig as plannerConfig } from "./planner.ts";
import { agentConfig as writerConfig } from "./writer.ts";

// Tipos

export interface AgentConfig {
	type: "coder" | "planner" | "writer";
	label: string;
	activeTools: string[] | null;
	agentsMd: string;
	allowedExtensions?: Record<string, string[]>;
}

// Estado

const AGENTS: Record<string, AgentConfig> = {
	coder: coderConfig,
	planner: plannerConfig,
	writer: writerConfig,
};

let currentType: AgentConfig["type"] = "coder";

// Helpers

/**
 * Tools gerenciadas por esta extensão — todas as tools built-in do pi.
 * Tools NÃO listadas aqui são tratadas como "custom" (de outras extensões)
 * e NUNCA são removidas ao restringir o conjunto ativo.
 *
 * ⚠️  Quando o pi adicionar novas tools built-in, adicione-as aqui.
 */
const MANAGED_TOOLS = new Set([
	"read", "bash", "edit", "write",
	"codegraph_codegraph_search", "codegraph_codegraph_context",
	"codegraph_codegraph_node", "codegraph_codegraph_explore",
	"codegraph_codegraph_trace", "mcp", "web_search", "web_agent", "web_fetch",
]);

function applyTools(pi: ExtensionAPI, config: AgentConfig): void {
	const current = pi.getActiveTools();

	if (config.activeTools === null) {
		// Modo irrestrito: garante que todas as tools gerenciadas estão
		// disponíveis, preservando tools de outras extensões.
		const restored = [...new Set([...current, ...MANAGED_TOOLS])];
		pi.setActiveTools(restored);
		return;
	}

	// Modo restrito: apenas tools da config + tools custom não-gerenciadas.
	const custom = current.filter((t) => !MANAGED_TOOLS.has(t));
	const merged = [...new Set([...config.activeTools, ...custom])];
	pi.setActiveTools(merged);
}

function blockedReason(config: AgentConfig, toolName: string, input: Record<string, unknown>): string | null {
	const restrictions = config.allowedExtensions;
	if (!restrictions) return null;

	const allowed = restrictions[toolName];
	if (!allowed) return null;

	// Só checa argumentos que são caminhos de arquivo com "/"
	for (const key of ["path", "filePath", "file", "oldPath", "newPath"]) {
		const val = input[key];
		if (typeof val !== "string") continue;
		if (!val.includes("/")) continue;
		const ext = val.slice(val.lastIndexOf("."));
		if (ext.length < 2 || ext.length > 6) continue;
		if (/\s/.test(ext)) continue;
		if (!allowed.includes(ext)) {
			return `"${toolName}" restrito a arquivos ${allowed.join(", ")} no modo ${config.label}. Alvo: ${val}`;
		}
	}
	return null;
}

function injectSystemPrompt(base: string, config: AgentConfig): string {
	return `${base}\n\n${config.agentsMd}`;
}

// Comando /agent

async function handleAgent(args: string, pi: ExtensionAPI, ctx: ExtensionContext) {
	const arg = args?.trim().toLowerCase();

	if (arg && (arg === "coder" || arg === "planner" || arg === "writer")) {
		doSwitch(arg, pi, ctx);
		return;
	}

	const options = Object.values(AGENTS).map((cfg) => {
		const curr = cfg.type === currentType;
		const desc =
			cfg.type === "coder" ? "Desenvolvimento de código"
			: cfg.type === "planner" ? "Planejamento e arquitetura"
			: "Criação e revisão de texto";
		return `${curr ? "● " : "  "}${cfg.label} — ${desc}`;
	});

	const pick = await ctx.ui.select(`Agente atual: ${AGENTS[currentType]?.label ?? "CODER"}\nSelecione o tipo:`, options);
	if (!pick) return;

	const match = Object.values(AGENTS).find((c) => pick.includes(c.label));
	if (match && match.type !== currentType) doSwitch(match.type, pi, ctx);
}

function doSwitch(type: AgentConfig["type"], pi: ExtensionAPI, ctx?: ExtensionContext) {
	const config = AGENTS[type];
	if (!config || config.type === currentType) return;

	currentType = type;

	applyTools(pi, config);
	pi.appendEntry("agent-switcher", { agent: type });
	pi.events?.emit("custom:agent-switch", { type });

	if (ctx) ctx.ui.notify(`Modo: ${config.label}`, "info");
}

// Entry point

export default function (pi: ExtensionAPI) {
	// Bloqueio de extensão (WRITER/PLANNER: só .md)
	pi.on("tool_call", async (event) => {
		const config = AGENTS[currentType];
		if (!config) return;
		const reason = blockedReason(config, event.toolName, event.input as Record<string, unknown>);
		if (reason) return { block: true, reason };
	});

	// Comando
	pi.registerCommand("agent", {
		description: "Alternar tipo de agente: coder, planner, writer",
		getArgumentCompletions: (p: string) => {
			const n = p.trim().toLowerCase();
			return Object.values(AGENTS)
				.filter((c) => c.type.startsWith(n))
				.map((c) => ({ value: c.type, label: c.label }));
		},
		handler: async (args, ctx) => handleAgent(args, pi, ctx),
	});

	// Restaura estado ao iniciar sessão.
	// NÃO emite custom:agent-switch aqui — status-bar lê diretamente da
	// sessão, evitando condição de corrida com a criação do editor.
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "agent-switcher")
			.pop() as { data?: { agent?: string } } | undefined;

		const saved = last?.data?.agent;
		if (saved && (saved === "coder" || saved === "planner" || saved === "writer")) {
			currentType = saved;
		}

		const config = AGENTS[currentType];
		if (config) {
			applyTools(pi, config);
		}
	});

	// Injeta AGENTS.md no system prompt a cada turno
	pi.on("before_agent_start", async (event) => {
		const config = AGENTS[currentType];
		if (!config) return;
		return { systemPrompt: injectSystemPrompt(event.systemPrompt, config) };
	});
}
