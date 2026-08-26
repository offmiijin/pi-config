import type { AutocompleteItem } from "@earendil-works/pi-tui";

const INFO: AutocompleteItem = {
	value: "info",
	label: "info",
	description: "Mostra informações da memória persistente",
};

/** Sugestões para os argumentos de `/memory`. */
export function getMemoryArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	if (INFO.value.startsWith(prefix)) return [INFO];
	return null;
}
