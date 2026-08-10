import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_LEVELS: { value: ThinkingLevel; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "Sem reasoning/thinking" },
  { value: "minimal", label: "Minimal", description: "Mínimo esforço de reasoning" },
  { value: "low", label: "Low", description: "Baixo esforço de reasoning" },
  { value: "medium", label: "Medium", description: "Médio esforço de reasoning" },
  { value: "high", label: "High", description: "Alto esforço de reasoning" },
  { value: "xhigh", label: "X-High", description: "Máximo esforço de reasoning" },
];

function getCurrentLevel(pi: ExtensionAPI): ThinkingLevel {
  return pi.getThinkingLevel() as ThinkingLevel;
}

async function handleThinking(args: string, pi: ExtensionAPI, ctx: ExtensionContext) {
  const current = getCurrentLevel(pi);

  if (args.trim()) {
    const level = args.trim().toLowerCase() as ThinkingLevel;
    if (THINKING_LEVELS.some((l) => l.value === level)) {
      pi.setThinkingLevel(level);
      ctx.ui.notify(`Thinking level alterado para: ${level}`, "info");
      return;
    }
    ctx.ui.notify(`Nível inválido: ${level}. Use: off, minimal, low, medium, high, xhigh`, "error");
    return;
  }

  const options = THINKING_LEVELS.map((l) => {
    const isCurrent = l.value === current;
    const prefix = isCurrent ? "● " : "  ";
    return `${prefix}${l.label} — ${l.description}`;
  });

  const choice = await ctx.ui.select(
    `Nível atual: ${current}\nSelecione o nível de thinking:`,
    options,
  );

  if (!choice) return;

  const selected = THINKING_LEVELS.find((l) => choice.startsWith("●") ? choice.includes(l.label) : choice.startsWith(`  ${l.label}`));
  if (selected && selected.value !== current) {
    pi.setThinkingLevel(selected.value);
    ctx.ui.notify(`Thinking level alterado de "${current}" para "${selected.value}"`, "info");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("thinking", {
    description: "Alterar nível de thinking (off, minimal, low, medium, high, xhigh)",
    handler: async (args, ctx) => handleThinking(args, pi, ctx),
  });
}