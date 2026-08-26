/**
 * Comando /memory config.
 *
 * A configuração é organizada como um menu para acomodar futuras opções.
 * A seleção de modelos usa o catálogo e a autenticação já resolvidos pelo Pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	ui: Pick<ExtensionContext["ui"], "select" | "notify">;
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
			seen.add(key);
			try {
				return ctx.modelRegistry.hasConfiguredAuth(model);
			} catch {
				return false;
			}
		})
		.sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

async function chooseModelProcessor(ctx: ConfigContext): Promise<void> {
	const models = availableAuthenticatedModels(ctx);
	if (models.length === 0) {
		ctx.ui.notify("Nenhum modelo autenticado está disponível no Pi.", "warning");
		return;
	}

	const current = getModelProcessorConfig();
	const labels = models.map((model) => {
		const selected = modelKey(model) === modelKey(current) ? " (selected)" : "";
		const displayName = model.name && model.name !== model.id ? ` — ${model.name}` : "";
		return `${modelKey(model)}${selected}${displayName}`;
	});
	const selected = await ctx.ui.select("Model processor", labels);
	if (selected === undefined) return;

	const selectedIndex = labels.indexOf(selected);
	const model = models[selectedIndex];
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
