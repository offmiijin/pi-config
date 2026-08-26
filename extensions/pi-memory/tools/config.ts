/**
 * Comando /memory config.
 *
 * A configuração é organizada como um menu para acomodar futuras opções.
 * A seleção de modelos usa o catálogo e a autenticação já resolvidos pelo Pi.
 */

import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
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
	scopedModels?: readonly { model: RegistryModel }[];
}

function modelKey(model: MemoryModelConfig): string {
	return `${model.provider}/${model.id}`;
}

export function availableAuthenticatedModels(ctx: ConfigContext): RegistryModel[] {
	const scoped = ctx.scopedModels ?? [];
	const models = scoped.length > 0 ? scoped.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
	const seen = new Set<string>();
	return models
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

function modelLabels(models: RegistryModel[], current: MemoryModelConfig): string[] {
	return models.map((model) => {
		const selected = modelKey(model) === modelKey(current) ? " (selected)" : "";
		const displayName = model.name && model.name !== model.id ? ` — ${model.name}` : "";
		return `${modelKey(model)}${selected}${displayName}`;
	});
}

async function selectModel(ctx: ConfigContext, models: RegistryModel[], labels: string[]): Promise<string | undefined> {
	if (ctx.mode !== "tui") return ctx.ui.select("Model processor", labels);

	return (await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const search = new Input();
		const list = new SelectList(
			models.map((model, index) => ({ value: modelKey(model), label: labels[index] })),
			Math.min(models.length, 10),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		search.focused = true;
		search.onEscape = () => done(null);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);

		const updateFilter = () => {
			list.setFilter(search.getValue());
			container.invalidate();
			tui.requestRender();
		};

		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Model processor"))));
		container.addChild(new Text(theme.fg("dim", "Search: ")));
		container.addChild(search);
		container.addChild(list);
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
		description: "Configurações da memória persistente",
		handler: async (args, rawCtx) => {
			const ctx = rawCtx as unknown as ConfigContext;
			if (args.trim() !== "config") {
				ctx.ui.notify("Uso: /memory config", "info");
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
