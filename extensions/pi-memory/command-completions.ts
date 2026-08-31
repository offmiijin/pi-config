import type { AutocompleteItem } from "@earendil-works/pi-tui";

const CONFIG: AutocompleteItem = {
	value: "config",
	label: "config",
	description: "Configura a memória persistente",
};

const INFO: AutocompleteItem = {
	value: "info",
	label: "info",
	description: "Mostra informações da memória persistente",
};

/** Sugestões para os argumentos de `/memory`. */
export function getMemoryArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const suggestions = [CONFIG, INFO].filter((item) => item.value.startsWith(prefix));
	return suggestions.length > 0 ? suggestions : null;
}
