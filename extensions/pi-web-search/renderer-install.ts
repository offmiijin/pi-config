import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
	getRendererCommand,
	getRendererInstallDir,
	getRendererTimeoutMs,
	setRendererCommand,
} from "./config";
import { RendererClient } from "./renderer-client";

export interface RendererInstallResult {
	ok: boolean;
	output: string;
	command: string;
	busy?: boolean;
}

export interface RendererValidationResult {
	ok: boolean;
	error?: string;
}

export type RendererInstallProgress = (chunk: string) => void;

let rendererInstallInProgress = false;

export function isRendererInstallationInProgress(): boolean {
	return rendererInstallInProgress;
}

/** Executa o instalador versionado junto com a extensão, sem shell intermediário. */
export function installRenderer(
	signal?: AbortSignal,
	onOutput?: RendererInstallProgress,
): Promise<RendererInstallResult> {
	const command = join(getRendererInstallDir(), "pi-web-renderer");
	if (rendererInstallInProgress) {
		return Promise.resolve({
			ok: false,
			busy: true,
			output: "Outra instalação do renderer já está em andamento.",
			command,
		});
	}

	rendererInstallInProgress = true;
	return runRendererInstall(signal, onOutput).finally(() => {
		rendererInstallInProgress = false;
	});
}

function runRendererInstall(
	signal?: AbortSignal,
	onOutput?: RendererInstallProgress,
): Promise<RendererInstallResult> {
	const script = fileURLToPath(new URL("./renderer/install.sh", import.meta.url));
	const command = join(getRendererInstallDir(), "pi-web-renderer");

	return new Promise((resolve) => {
		const child = spawn("bash", [script], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: string[] = [];
		let settled = false;

		const finish = (result: RendererInstallResult) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => {
			child.kill();
			finish({ ok: false, output: "ABORTED", command });
		};
		const collect = (chunk: Buffer) => {
			const text = chunk.toString();
			chunks.push(text);
			onOutput?.(text);
		};

		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (error) => {
			finish({ ok: false, output: `${chunks.join("")}\n${error.message}`, command });
		});
		child.on("close", (code) => {
			if (code === 0) {
				try {
					setRendererCommand(command);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					finish({ ok: false, output: `${chunks.join("")}\n${message}`, command });
					return;
				}
			}
			finish({
				ok: code === 0,
				output: chunks.join(""),
				command,
			});
		});
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Valida o protocolo JSONL e a inicialização real do Chromium. */
export async function validateRendererInstallation(
	command = getRendererCommand(),
	timeoutMs = getRendererTimeoutMs(),
): Promise<RendererValidationResult> {
	const client = new RendererClient(command, timeoutMs);
	try {
		await client.health();
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		client.close();
	}
}
