import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setRendererCommand, getRendererCommand } from "./config";

export interface RendererInstallResult {
	ok: boolean;
	output: string;
	command: string;
}

/** Executa o instalador versionado junto com a extensão, sem shell intermediário. */
export function installRenderer(signal?: AbortSignal): Promise<RendererInstallResult> {
	const script = fileURLToPath(new URL("./renderer/install.sh", import.meta.url));
	const command = getRendererCommand();

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
			chunks.push(chunk.toString());
		};

		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (error) => {
			finish({ ok: false, output: `${chunks.join("")}\n${error.message}`, command });
		});
		child.on("close", (code) => {
			if (code === 0) {
				setRendererCommand(command);
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
