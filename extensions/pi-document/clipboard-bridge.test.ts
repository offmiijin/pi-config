import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeClipboardPaths } from "./clipboard-bridge";

describe("clipboard-bridge", () => {
	it("materializa caminhos temporários no workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-clipboard-bridge-"));
		const source = path.join("/tmp", "pi-clipboard-42dbbabe-72bc-44c3-ae2d-0978a44f9c95.png");
		await fs.writeFile(source, "fake-png");

		const result = await materializeClipboardPaths(
			`analise ${source}`,
			root,
			"session-1",
		);
		const target = path.join(root, ".sandbox-cache", "attachments", "session-1", "imagem.png");

		expect(result).toContain(target);
		expect(await fs.readFile(target, "utf8")).toBe("fake-png");
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(source, { force: true });
	});

	it("não altera prompts sem caminho temporário do clipboard", async () => {
		expect(await materializeClipboardPaths("prompt normal", "/tmp", "session-1")).toBe("prompt normal");
	});
});
