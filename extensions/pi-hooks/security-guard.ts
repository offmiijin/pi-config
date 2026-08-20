/**
 * Security Guard Hook — escopo mínimo.
 *
 * Intercepta apenas o que o dev-sandbox NÃO cobre:
 *   - Fork bomb (`:(){ :|:& };:`) — namespaces não limitam processos;
 *     consome CPU/memória do host.
 *   - Download + execução direta (`curl|bash`, `wget|sh`, `bash <(curl)`,
 *     `source <(curl)`) — roda no workspace com rede no perfil normal.
 *     (O bash-ops do dev-sandbox também bloqueia; aqui é defesa em
 *     profundidade com confirmação interativa.)
 *   - `eval` com entrada dinâmica — execução de código arbitrário.
 *
 * Ameaças de filesystem/sistema/container NÃO estão aqui: o sandbox
 * (namespaces, capabilities dropadas, seccomp, HOME isolado,
 * denyFilePatterns, diretórios de quarentena) já as neutraliza.
 *
 * Modos via env PI_SECURITY_MODE:
 *   interactive (default) | strict | permissive | audit-only
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "interactive" | "strict" | "permissive" | "audit-only";

interface SecurityConfig {
  mode: Mode;
}

const PATTERNS: { pattern: RegExp; severity: string; reason: string }[] = [
  { pattern: /\b:\(\)\{ :\|:& \}\;:/, severity: "critical", reason: "Fork bomb" },
  { pattern: /\bcurl\b[^|;\n]*\|\s*(?:sudo\s+)?(ba)?sh\b/i, severity: "critical", reason: "Download e execução direta de script" },
  { pattern: /\bwget\b[^|;\n]*\|\s*(?:sudo\s+)?(ba)?sh\b/i, severity: "critical", reason: "Download e execução direta de script" },
  { pattern: /\b(ba)?sh\s+<\(\s*(curl|wget)\b/i, severity: "critical", reason: "Bash subshell com download remoto" },
  { pattern: /\b(source|\.)\s+<\(\s*(curl|wget)\b/i, severity: "critical", reason: "Source de download remoto" },
  { pattern: /\beval\s+['`$]/, severity: "high", reason: "eval com entrada potencialmente insegura" },
];

function getConfig(): SecurityConfig {
  return { mode: (process.env.PI_SECURITY_MODE as Mode) ?? "interactive" };
}

function maskCommand(cmd: string): string {
  return cmd.replace(/(?<=API_KEY=|api_key=|token=|password=|secret=|key=|--password\s+|--token\s+)\S+/gi, "***");
}

async function handleBashCommand(
  command: string,
  ctx: any,
  config: SecurityConfig,
): Promise<{ block: boolean; reason?: string } | undefined> {
  for (const entry of PATTERNS) {
    if (entry.pattern.test(command)) {
      const masked = maskCommand(command);

      if (config.mode === "strict") {
        return { block: true, reason: `[BLOQUEADO] ${entry.reason}` };
      }

      if (config.mode === "audit-only" || config.mode === "permissive") {
        if (ctx?.hasUI) {
          ctx.ui.notify(`[SEGURANÇA] ${entry.reason}: ${masked} (${config.mode})`, "warning");
        }
        return undefined;
      }

      if (!ctx.hasUI) {
        return { block: true, reason: `[BLOQUEADO] ${entry.reason} (modo não-interativo)` };
      }

      const choice = await ctx.ui.select(
        `\u26A0\uFE0F Alerta de segurança (${entry.severity.toUpperCase()}):\n  ${entry.reason}\n\nComando: ${masked}`,
        ["Permitir esta vez", "Bloquear"],
      );

      if (choice === "Bloquear") {
        return { block: true, reason: `[BLOQUEADO PELO USUÁRIO] ${entry.reason}` };
      }

      if (ctx?.hasUI) {
        ctx.ui.notify(`[SEGURANÇA] ${entry.reason}: ${masked} (permitido pelo usuário)`, "warning");
      }
      return undefined;
    }
  }

  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx?.hasUI) {
      ctx.ui.notify(
        `[SEGURANÇA] Guarda carregado. Modo: ${process.env.PI_SECURITY_MODE ?? "interactive"}`,
        "info",
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = getConfig();
    if (event.toolName !== "bash") return undefined;

    const command = (event.input as Record<string, unknown>).command as string;
    if (!command) return undefined;

    return handleBashCommand(command, ctx, config);
  });
}
