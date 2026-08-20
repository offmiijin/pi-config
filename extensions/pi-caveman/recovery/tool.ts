import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RecoveryStore } from "./store.ts";
import { isRecoveryHandle } from "./handles.ts";

export const RECOVERY_TOOL_NAME = "caveman_retrieve";

export function registerRecoveryTool(pi: ExtensionAPI, store: RecoveryStore): void {
	pi.registerTool({
		name: RECOVERY_TOOL_NAME,
		label: "Recuperar conteúdo Caveman",
		description: "Recupera o conteúdo original associado a um handle <<ccr:...>> do pi-caveman.",
		parameters: Type.Object({
			recovery_handle: Type.String({ description: "Handle no formato ccr_ seguido de 32 caracteres hexadecimais." }),
		}),
		async execute(_toolCallId, params) {
			if (!isRecoveryHandle(params.recovery_handle)) {
				throw new Error("Handle de recuperação inválido.");
			}
			try {
				const content = await store.get(params.recovery_handle);
				return {
					content: [{ type: "text", text: content }],
					details: { recovery_handle: params.recovery_handle, recovered: true },
				};
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") throw new Error(`Conteúdo não encontrado para ${params.recovery_handle}.`);
				throw error;
			}
		},
	});
}
