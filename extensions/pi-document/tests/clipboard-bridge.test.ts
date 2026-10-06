import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeClipboardPaths } from "../clipboard-bridge";

const tempDirs: string[] = [];
const tempSources: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
	await Promise.all(tempSources.splice(0).map((file) => fs.rm(file, { force: true })));
});

describe("clipboard-bridge", () => {
	it("materializa caminhos temporários no workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-clipboard-bridge-"));
		tempDirs.push(root);
		const source = path.join("/tmp", `pi-clipboard-${randomUUID()}.png`);
		tempSources.push(source);
		await fs.writeFile(source, "fake-png");

		const result = await materializeClipboardPaths(`analise ${source}`, root, "session-1");
		const target = path.join(root, ".sandbox-cache", "attachments", "session-1", "imagem.png");

		expect(result).toContain(target);
		expect(await fs.readFile(target, "utf8")).toBe("fake-png");
	});

	it("não altera prompts sem caminho temporário do clipboard", async () => {
		expect(await materializeClipboardPaths("prompt normal", "/tmp", "session-1")).toBe("prompt normal");
	});
});
