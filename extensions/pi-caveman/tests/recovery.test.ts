import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleFor, isRecoveryHandle } from "../recovery/handles.ts";
import { RecoveryStore } from "../recovery/store.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storeFixture(): Promise<RecoveryStore> {
	const root = await mkdtemp(join(tmpdir(), "pi-caveman-recovery-"));
	temporaryRoots.push(root);
	const store = new RecoveryStore(root);
	await store.open();
	return store;
}

describe("handles CCR", () => {
	it("é determinístico e validável", () => {
		const first = handleFor("conteúdo original");
		expect(first).toBe(handleFor("conteúdo original"));
		expect(first).toMatch(/^ccr_[0-9a-f]{32}$/);
		expect(isRecoveryHandle(first)).toBe(true);
		expect(isRecoveryHandle("ccr_not-valid")).toBe(false);
	});
});

describe("RecoveryStore", () => {
	it("salva e recupera conteúdo UTF-8 exatamente", async () => {
		const store = await storeFixture();
		const original = "linha 1\nacentuação: çãé\n";
		const saved = await store.put(original);

		expect(saved.handle).toBe(handleFor(original));
		expect(saved.bytes).toBe(Buffer.byteLength(original, "utf8"));
		expect(saved.created).toBe(true);
		expect(await store.get(saved.handle)).toBe(original);
	});

	it("deduplica o mesmo conteúdo", async () => {
		const store = await storeFixture();
		const first = await store.put("repetido");
		const second = await store.put("repetido");

		expect(second.handle).toBe(first.handle);
		expect(second.created).toBe(false);
		expect(await store.has(first.handle)).toBe(true);
	});

	it("recusa handles inválidos e conteúdo inexistente", async () => {
		const store = await storeFixture();
		await expect(store.get("ccr_invalid")).rejects.toThrow("invalid recovery handle");
		await expect(store.get("ccr_00000000000000000000000000000000")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await store.has("ccr_invalid")).toBe(false);
	});

	it("usa arquivos privados", async () => {
		const store = await storeFixture();
		const saved = await store.put("segredo local");
		const root = temporaryRoots[0]!;
		const bytes = await readFile(join(root, "objects", saved.handle));
		expect(bytes.toString()).toBe("segredo local");
	});
});
