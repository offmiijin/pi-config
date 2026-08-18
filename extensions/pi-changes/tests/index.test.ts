import { describe, expect, it } from "vitest";
import registerChanges from "../index.ts";

describe("extensão pi-changes", () => {
	it("intercepta Alt+D pelo terminal antes do editor", async () => {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		let inputListener: ((data: string) => unknown) | undefined;
		let customOptions: any;
		let shortcutRegistered = false;
		const ctx = {
			mode: "tui",
			cwd: "/repo",
			ui: {
				onTerminalInput: (handler: (data: string) => unknown) => {
					inputListener = handler;
					return () => { inputListener = undefined; };
				},
				notify: () => {},
				custom: async (_factory: unknown, options: unknown) => { customOptions = options; },
			},
		};
		const pi = {
			on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers[name] = handler; },
			registerShortcut: () => { shortcutRegistered = true; },
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		};

		registerChanges(pi as any);
		await handlers.session_start!({}, ctx);

		expect(shortcutRegistered).toBe(false);
		expect(inputListener).toBeDefined();
		expect(inputListener!("\x1bd")).toEqual({ consume: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(customOptions.overlayOptions.anchor).toBe("center");
	});
});
