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

/**
 * Deriva os níveis de thinking suportados pelo modelo ativo, seguindo a
 * semântica tristate do `thinkingLevelMap` (docs/models.md):
 * - `null` → nível não suportado (escondido)
 * - string → nível suportado (valor enviado ao provider)
 * - omitido → `off`..`high` suportados via mapeamento default do provider;
 *   `xhigh`/`max` omitidos são NÃO suportados
 */
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
    return `${prefix}${l.label} — ${l.description}`;
  });

  const choice = await ctx.ui.select(
    `Modelo: ${modelName}\nNível atual: ${current}\nSuportados: ${supported.join(", ")}\nSelecione o nível de thinking:`,
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
    description: "Alterar nível de thinking (off, minimal, low, medium, high, xhigh, max)",
    handler: async (args, ctx) => handleThinking(args, pi, ctx),
  });
}
