/**
 * Hooks — Extensões de segurança e comportamento para o agente.
 *
 * Carrega todos os hooks que monitoram e/ou bloqueiam operações
 * perigosas em tool calls (bash, write, edit, read).
 *
 * Hooks carregados:
 *   - block-force-push.ts → bloqueia git push --force para main/master
 *   - security-guard.ts   → bloqueia comandos destrutivos e acesso a paths sensíveis
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import blockForcePush from "./block-force-push.ts";
import securityGuard from "./security-guard.ts";

export default function (pi: ExtensionAPI) {
	blockForcePush(pi);
	securityGuard(pi);
}
