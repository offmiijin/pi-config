import { createInterface, type Interface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getRendererCommand, getRendererTimeoutMs } from "./config";

export interface RenderedPage {
	finalUrl: string;
	status?: number | null;
	html: string;
	elapsedMs?: number;
}

interface RendererResponse {
	id?: string;
	ok?: boolean;
	error?: string;
	finalUrl?: string;
	status?: number | null;
	html?: string;
	action?: string;
	elapsedMs?: number;
}

interface PendingRequest {
	resolve: (value: RenderedPage) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	onAbort?: () => void;
}

let requestCounter = 0;
let sharedClient: RendererClient | undefined;
let sharedCommand: string | undefined;

/** Retorna um cliente persistente compartilhado entre chamadas de web_fetch. */
export function getSharedRendererClient(): RendererClient {
	const command = getRendererCommand();
	if (!sharedClient || sharedCommand !== command) {
		sharedClient?.close();
		sharedClient = new RendererClient(command, getRendererTimeoutMs());
		sharedCommand = command;
	}
	return sharedClient;
}

/** Encerra o processo compartilhado ao finalizar a sessão da extensão. */
export function closeSharedRendererClient(): void {
	sharedClient?.close();
	sharedClient = undefined;
	sharedCommand = undefined;
}

/** Cliente persistente do processo Python que renderiza JavaScript. */
export class RendererClient {
	private child: ChildProcessWithoutNullStreams | undefined;
	private reader: Interface | undefined;
	private pending = new Map<string, PendingRequest>();
	private readonly command: string;
	private readonly timeoutMs: number;
	private closed = false;

	constructor(command = getRendererCommand(), timeoutMs = getRendererTimeoutMs()) {
		this.command = command;
		this.timeoutMs = timeoutMs;
	}

	async health(signal?: AbortSignal): Promise<void> {
		await this.request({ action: "health" }, signal);
	}

	async render(url: string, signal?: AbortSignal): Promise<RenderedPage> {
		return this.request({ url }, signal);
	}

	close(): void {
		this.closed = true;
		this.rejectPending(new Error("Renderer encerrado"));
		this.reader?.close();
		this.reader = undefined;
		if (this.child && this.child.exitCode === null) this.child.kill();
		this.child = undefined;
	}

	private request(
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<RenderedPage> {
		if (this.closed) return Promise.reject(new Error("Renderer encerrado"));
		if (signal?.aborted) return Promise.reject(new Error("ABORTED"));

		this.start();
		const id = `renderer-${Date.now()}-${++requestCounter}`;
		const message = JSON.stringify({ id, ...payload }) + "\n";

		return new Promise<RenderedPage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.restart(new Error("Renderer timeout"));
				reject(new Error("Renderer timeout"));
			}, this.timeoutMs);

			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				this.restart(new Error("ABORTED"));
				reject(new Error("ABORTED"));
			};
			if (signal) signal.addEventListener("abort", onAbort, { once: true });

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
				onAbort,
			});

			try {
				this.child!.stdin.write(message);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private start(): void {
		if (this.child && this.child.exitCode === null) return;
		if (this.closed) throw new Error("Renderer encerrado");

		const child = spawn(this.command, [], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.reader = createInterface({ input: child.stdout });
		this.reader.on("line", (line) => this.handleLine(line));
		child.stderr.on("data", () => {
			// stderr é reservado para diagnóstico do renderer; não contamina o JSONL.
		});
		child.on("error", (error) => this.rejectPending(error));
		child.on("close", (code) => {
			this.reader?.close();
			this.reader = undefined;
			this.child = undefined;
			if (!this.closed && code !== 0) {
				this.rejectPending(new Error(`Renderer encerrou com código ${code ?? "desconhecido"}`));
			}
		});
	}

	private handleLine(line: string): void {
		let response: RendererResponse;
		try {
			response = JSON.parse(line) as RendererResponse;
		} catch {
			this.restart(new Error("Renderer retornou JSON inválido"));
			return;
		}

		if (!response.id) return;
		const request = this.pending.get(response.id);
		if (!request) return;
		this.pending.delete(response.id);

		if (!response.ok) {
			request.reject(new Error(response.error || "Falha no renderer"));
			return;
		}
		if (response.action === "health") {
			request.resolve({ finalUrl: "", html: "" });
			return;
		}
		if (typeof response.html !== "string") {
			request.reject(new Error("Renderer não retornou HTML"));
			return;
		}

		request.resolve({
			finalUrl: response.finalUrl || "",
			status: response.status,
			html: response.html,
			elapsedMs: response.elapsedMs,
		});
	}

	private restart(error: Error): void {
		this.rejectPending(error);
		this.reader?.close();
		if (this.child && this.child.exitCode === null) this.child.kill();
		this.reader = undefined;
		this.child = undefined;
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}
}
