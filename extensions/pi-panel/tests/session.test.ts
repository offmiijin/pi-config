import { describe, expect, it } from "vitest";
import { PANEL_SESSION_ENTRY, reconstructPanelSession } from "../session.ts";

describe("sessão — âncora do pi-panel", () => {
	it("usa o último snapshot válido da sessão", () => {
		expect(reconstructPanelSession([
			{ type: "custom", customType: PANEL_SESSION_ENTRY, data: { version: 1, baseCommit: "base-antiga" } },
			{ type: "custom", customType: "outro", data: {} },
			{ type: "custom", customType: PANEL_SESSION_ENTRY, data: { version: 1, baseCommit: " base-atual " } },
		])).toEqual({ version: 1, baseCommit: "base-atual" });
	});

	it("ignora snapshots inválidos sem perder o último estado válido", () => {
		expect(reconstructPanelSession([
			{ type: "custom", customType: PANEL_SESSION_ENTRY, data: { version: 1, baseCommit: "base" } },
			{ type: "custom", customType: PANEL_SESSION_ENTRY, data: { version: 2, baseCommit: "ignorada" } },
			{ type: "custom", customType: PANEL_SESSION_ENTRY, data: { version: 1, baseCommit: "   " } },
		])).toEqual({ version: 1, baseCommit: "base" });
	});

	it("retorna vazio quando a sessão não possui âncora", () => {
		expect(reconstructPanelSession([{ type: "message" }])).toBeNull();
	});
});
