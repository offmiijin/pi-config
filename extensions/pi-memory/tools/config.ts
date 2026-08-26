/**
 * Comando /memory config.
 *
 * A configuração é organizada como um menu para acomodar futuras opções.
 * A seleção de modelos usa o catálogo e a autenticação já resolvidos pelo Pi.
 */

import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { getMemoryArgumentCompletions } from "../command-completions.ts";
import {
	getModelProcessorConfig,
	saveModelProcessorConfig,
	type MemoryModelConfig,
} from "../memory/config.ts";

interface RegistryModel {
	provider: string;
	id: string;
	name?: string;
}

interface ModelRegistry {
	getAvailable(): RegistryModel[];
	hasConfiguredAuth(model: RegistryModel): boolean;
}

interface ConfigContext {
	ui: Pick<ExtensionContext["ui"], "select" | "notify" | "custom">;
	mode: ExtensionContext["mode"];
	modelRegistry: ModelRegistry;
}

function modelKey(model: MemoryModelConfig): string {
	return `${model.provider}/${model.id}`;
}

export function availableAuthenticatedModels(ctx: ConfigContext): RegistryModel[] {
	const seen = new Set<string>();
	return ctx.modelRegistry.getAvailable()
		.filter((model) => {
			const key = modelKey(model);
			if (seen.has(key)) return false;
			try {
				if (!ctx.modelRegistry.hasConfiguredAuth(model)) return false;
				seen.add(key);
				return true;
			} catch {
				return false;
			}
		})
		.sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

export function modelLabels(models: RegistryModel[], current: MemoryModelConfig): string[] {
	return models.map((model) => {
		const selected = modelKey(model) === modelKey(current) ? "● " : "  ";
		return `${selected}${model.id} [${model.provider}]`;
	});
}

function modelSearchText(model: RegistryModel): string {
	return `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase();
}

/** Filtra por ocorrência em provider, id ou nome, não apenas por prefixo. */
export function filterModels(models: RegistryModel[], query: string): RegistryModel[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return models;
	return models.filter((model) => modelSearchText(model).includes(normalized));
}

async function selectModel(ctx: ConfigContext, models: RegistryModel[], labels: string[]): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		const selectedLabel = await ctx.ui.select("Model processor", labels);
		if (selectedLabel === undefined) return undefined;
		const selectedIndex = labels.indexOf(selectedLabel);
		return selectedIndex >= 0 ? modelKey(models[selectedIndex]) : undefined;
	}

	return (await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const search = new Input();
		const entries = models.map((model, index) => ({ model, label: labels[index] }));
		const listContainer = new Container();
		const listTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};
		let list = new SelectList(
			entries.map((entry) => ({ value: modelKey(entry.model), label: entry.label })),
			Math.min(models.length, 10),
			listTheme,
		);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		listContainer.addChild(list);

		const updateFilter = () => {
			const filtered = filterModels(models, search.getValue());
			listContainer.removeChild(list);
			list = new SelectList(
				filtered.map((model) => ({
					value: modelKey(model),
					label: labels[models.indexOf(model)],
				})),
				Math.min(Math.max(filtered.length, 1), 10),
				listTheme,
			);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			listContainer.addChild(list);
			container.invalidate();
			tui.requestRender();
		};

		search.focused = true;
		search.onEscape = () => done(null);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Model processor"))));
		container.addChild(new Text(theme.fg("dim", "Search: ")));
		container.addChild(search);
		container.addChild(listContainer);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "escape")) {
					done(null);
					return;
				}
				if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter")) {
					list.handleInput(data);
					return;
				}
				search.handleInput(data);
				updateFilter();
			},
		};
	})) ?? undefined;
}

async function chooseModelProcessor(ctx: ConfigContext): Promise<void> {
	const models = availableAuthenticatedModels(ctx);
	if (models.length === 0) {
		ctx.ui.notify("Nenhum modelo autenticado está disponível no Pi.", "warning");
		return;
	}

	const current = getModelProcessorConfig();
	const labels = modelLabels(models, current);
	const selected = await selectModel(ctx, models, labels);
	if (selected === undefined) return;

	const model = models.find((candidate) => modelKey(candidate) === selected);
	if (!model) return;

	try {
		saveModelProcessorConfig({ provider: model.provider, id: model.id });
		ctx.ui.notify(`Modelo do processor definido: ${modelKey(model)}`, "info");
	} catch (err) {
		ctx.ui.notify(`Não foi possível salvar a configuração: ${(err as Error).message}`, "error");
	}
}

export function registerMemoryConfig(pi: ExtensionAPI): void {
	pi.registerCommand("memory", {
		description: "Configurações da memória persistente; use /memory info para informações",
		getArgumentCompletions: getMemoryArgumentCompletions,
		handler: async (args, rawCtx) => {
			const ctx = rawCtx as unknown as ConfigContext;
			const command = args.trim();
			if (command === "info") {
				const configured = getModelProcessorConfig();
				ctx.ui.notify(
					[
						"Memória persistente",
						"",
						`Model processor: ${modelKey(configured)}`,
						"Autenticação: reutiliza as credenciais configuradas no Pi",
					].join("\n"),
					"info",
				);
				return;
			}
			if (command !== "config") {
				ctx.ui.notify("Uso: /memory config ou /memory info", "info");
				return;
			}

			const current = getModelProcessorConfig();
			const option = await ctx.ui.select("Memory configuration", [
				`Model processor (${modelKey(current)})`,
			]);
			if (option === undefined) return;
			await chooseModelProcessor(ctx);
		},
	});
}
