/**
 * Hooks — Extensões de segurança e comportamento para o agente.
 *
 * Carrega todos os hooks que monitoram e/ou bloqueiam operações
 * perigosas em tool calls (bash).
 *
 * Hooks carregados:
 *   - block-force-push.ts       → bloqueia git push --force para main/master
 *   - block-protected-commit.ts → bloqueia git commit em main/master/development
 *   - security-guard.ts         → bloqueia o que o pi-sandbox não cobre
 *     (fork bomb, download+pipe a bash, eval dinâmico)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import blockForcePush from "./block-force-push.ts";
import blockProtectedCommit from "./block-protected-commit.ts";
import securityGuard from "./security-guard.ts";

export default function (pi: ExtensionAPI) {
	blockForcePush(pi);
	blockProtectedCommit(pi);
	securityGuard(pi);
}
