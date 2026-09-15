/**
 * Pi Status Bar — componentes visuais para o TUI do pi.
 *
 * Componentes incluídos:
 *   • status-bar — editor customizado (modelo, tokens) + footer (branch git)
 *
 * Auto-descoberto via pi-status-bar/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStatusBar } from "./status-bar.ts";
export default function (pi: ExtensionAPI) {
	registerStatusBar(pi);
}
