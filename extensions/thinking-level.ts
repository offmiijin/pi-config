import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingLevelModel = {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

const STANDARD_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const EXTENDED_LEVELS: ThinkingLevel[] = ["xhigh", "max"];

const THINKING_LEVELS: { value: ThinkingLevel; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "Sem reasoning/thinking" },
  { value: "minimal", label: "Minimal", description: "Mínimo esforço de reasoning" },
  { value: "low", label: "Low", description: "Baixo esforço de reasoning" },
  { value: "medium", label: "Medium", description: "Médio esforço de reasoning" },
  { value: "high", label: "High", description: "Alto esforço de reasoning" },
  { value: "xhigh", label: "X-High", description: "Esforço muito alto de reasoning" },
  { value: "max", label: "Max", description: "Esforço máximo de reasoning" },
];

// Tristate thinkingLevelMap: null=exclui, string=inclui, omitido=default off..high; xhigh/max omitidos=NÃO
export function getSupportedLevels(model?: ThinkingLevelModel | null): ThinkingLevel[] {
  if (!model) return [...STANDARD_LEVELS];
  if (model.reasoning === false) return ["off"];
  const map = model.thinkingLevelMap;
  if (!map) return [...STANDARD_LEVELS];
  return [...STANDARD_LEVELS, ...EXTENDED_LEVELS].filter((level) => {
    const value = map[level];
    if (value === null) return false;
    if (typeof value === "string") return true;
    return STANDARD_LEVELS.includes(level);
  });
}

function getCurrentLevel(pi: ExtensionAPI): ThinkingLevel {
  return pi.getThinkingLevel() as ThinkingLevel;
}

function getModelName(model: { name?: string; id?: string } | undefined): string {
  return model?.name ?? model?.id ?? "desconhecido";
}

const LEVEL_SUFFIX_RE = /\[([a-z]+)\]\s*$/;

// Extrai nível do sufixo [valor] — por valor exato, não por label
export function parseSelectedLevel(choice: string): ThinkingLevel | undefined {
  const match = choice.match(LEVEL_SUFFIX_RE);
  if (!match) return undefined;
  const value = match[1] as ThinkingLevel;
  return THINKING_LEVELS.some((l) => l.value === value) ? value : undefined;
}

// Nível sugerido quando o atual não é suportado: maior suportado ≤ atual;
// se nenhum, o menor suportado (reduzir esforço é sempre seguro)
export function clampLevel(current: ThinkingLevel, supported: ThinkingLevel[]): ThinkingLevel | undefined {
  if (supported.includes(current)) return current;
  if (supported.length === 0) return undefined;
  const order = [...STANDARD_LEVELS, ...EXTENDED_LEVELS];
  const idx = order.indexOf(current);
  const below = supported.filter((l) => order.indexOf(l) <= idx);
  return below.length > 0 ? below[below.length - 1] : supported[0];
}

async function handleThinking(args: string, pi: ExtensionAPI, ctx: ExtensionContext) {
  const model = ctx.model;
  const supported = getSupportedLevels(model);
  const current = ctx.thinkingLevel ?? getCurrentLevel(pi);
  const modelName = getModelName(model);

  if (args.trim()) {
    const level = args.trim().toLowerCase() as ThinkingLevel;
    if (supported.includes(level)) {
      pi.setThinkingLevel(level);
      ctx.ui.notify(`Thinking level alterado para: ${level}`, "info");
      return;
    }
    ctx.ui.notify(
      `Nível inválido para ${modelName}: ${level}. Suportados: ${supported.join(", ")}`,
      "error",
    );
    return;
  }

  const options = THINKING_LEVELS.filter((l) => supported.includes(l.value)).map((l) => {
    const isCurrent = l.value === current;
    const prefix = isCurrent ? "● " : "  ";
    return `${prefix}${l.label} — ${l.description} [${l.value}]`;
  });

  const unsupported = !supported.includes(current);
  const suggested = unsupported ? clampLevel(current, supported) : undefined;
  if (unsupported) {
    ctx.ui.notify(
      `Nível atual "${current}" não suportado por ${modelName}. Sugerido: ${suggested}`,
      "warning",
    );
  }

  const choice = await ctx.ui.select(
    `Modelo: ${modelName}\nNível atual: ${current}${unsupported ? ` (não suportado — sugerido: ${suggested})` : ""}\nSuportados: ${supported.join(", ")}\nSelecione o nível de thinking:`,
    options,
  );

  if (!choice) return;

  const selected = parseSelectedLevel(choice);
  if (selected && selected !== current) {
    pi.setThinkingLevel(selected);
    ctx.ui.notify(`Thinking level alterado de "${current}" para "${selected}"`, "info");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("thinking", {
    description: "Alterar nível de thinking (off, minimal, low, medium, high, xhigh, max)",
    handler: async (args, ctx) => handleThinking(args, pi, ctx),
  });
}
