import { describe, expect, it, vi } from "vitest";

const markdownInstances: unknown[][] = [];

vi.mock("@earendil-works/pi-tui", () => ({
	Markdown: class MarkdownMock {
		constructor(...args: unknown[]) {
			markdownInstances.push(args);
		}
	},
}));

import extension from "../index.ts";

describe("entry point do pi-changelog", () => {
	it("registra o comando e o renderer do changelog", async () => {
		const commands = new Map<string, unknown>();
		const renderers = new Map<string, unknown>();
		const pi = {
			registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
			registerEntryRenderer: (name: string, renderer: unknown) => renderers.set(name, renderer),
		};

		await extension(pi as never);

		expect(commands.has("pi-changelog")).toBe(true);
		expect(renderers.has("changelog-viewer")).toBe(true);
	});

	it("rendereriza o conteúdo usando Markdown e o tema do pi", async () => {
		const renderers = new Map<string, (...args: unknown[]) => unknown>();
		const pi = {
			registerCommand: () => {},
			registerEntryRenderer: (name: string, renderer: (...args: unknown[]) => unknown) => renderers.set(name, renderer),
		};

		await extension(pi as never);
		const theme = {
			fg: (color: string, text: string) => `${color}:${text}`,
			bold: (text: string) => `bold:${text}`,
			italic: (text: string) => `italic:${text}`,
			underline: (text: string) => `underline:${text}`,
			strikethrough: (text: string) => `strike:${text}`,
		};

		renderers.get("changelog-viewer")!({ data: { content: "# Versão" } }, {}, theme);

		expect(markdownInstances.at(-1)?.[0]).toBe("# Versão");
		expect(markdownInstances.at(-1)?.[3]).toEqual(expect.objectContaining({
			heading: expect.any(Function),
			bold: expect.any(Function),
		}));
	});
});
