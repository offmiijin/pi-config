import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handleFor, isRecoveryHandle } from "./handles.ts";
import type { RecoveryObject } from "../types.ts";

export class RecoveryStore {
	private readonly objectsDir: string;
	private opened = false;

	constructor(private readonly rootDir: string) {
		this.objectsDir = join(rootDir, "objects");
	}

	async open(): Promise<void> {
		await mkdir(this.objectsDir, { recursive: true, mode: 0o700 });
		this.opened = true;
	}

	isOpen(): boolean {
		return this.opened;
	}

	async put(content: string): Promise<RecoveryObject> {
		this.assertOpen();
		const handle = handleFor(content);
		const target = this.pathFor(handle);
		const bytes = Buffer.byteLength(content, "utf8");

		try {
			const existing = await readFile(target);
			if (!existing.equals(Buffer.from(content, "utf8"))) {
				throw new Error(`recovery handle collision: ${handle}`);
			}
			return { handle, bytes, created: false };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temporary, target);
			return { handle, bytes, created: true };
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await readFile(target);
			if (!existing.equals(Buffer.from(content, "utf8"))) {
				throw new Error(`recovery handle collision: ${handle}`);
			}
			return { handle, bytes, created: false };
		}
	}

	async get(handle: string): Promise<string> {
		this.assertOpen();
		if (!isRecoveryHandle(handle)) throw new Error("invalid recovery handle");
		return readFile(this.pathFor(handle), "utf8");
	}

	async has(handle: string): Promise<boolean> {
		this.assertOpen();
		if (!isRecoveryHandle(handle)) return false;
		try {
			await stat(this.pathFor(handle));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	close(): void {
		this.opened = false;
	}

	private pathFor(handle: string): string {
		return join(this.objectsDir, handle);
	}

	private assertOpen(): void {
		if (!this.opened) throw new Error("recovery store is not open");
	}
}
