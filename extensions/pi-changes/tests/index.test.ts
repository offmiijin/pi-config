import { describe, expect, it } from "vitest";
import registerChanges from "../index.ts";

describe("extensão pi-changes", () => {
	it("registra Alt+D para alternar o painel", () => {
		let shortcut: { key: string; description?: string } | undefined;
		const pi = {
			registerShortcut: (key: string, options: { description?: string }) => {
				shortcut = { key, description: options.description };
			},
			on: () => {},
		} as any;

		registerChanges(pi);
		expect(shortcut).toEqual({
			key: "alt+d",
			description: "Abrir ou fechar o painel de alterações",
		});
	});
});
