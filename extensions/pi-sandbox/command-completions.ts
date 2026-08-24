import type { AutocompleteItem } from "@earendil-works/pi-tui";

const INFO: AutocompleteItem = {
  value: "info",
  label: "info",
  description: "Mostra informações da sessão do sandbox",
};

/** Sugestões para os argumentos de `/sandbox`. */
export function getSandboxArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  if (INFO.value.startsWith(prefix)) return [INFO];
  return null;
}
