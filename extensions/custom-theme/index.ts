/**
 * Custom Theme — extensões visuais para o TUI do pi.
 *
 * Extensões incluídas:
 *   • status-bar     — editor customizado (modelo, tokens) + footer (branch git)
 *
 * Auto-descoberto via custom-theme/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStatusBar } from "./status-bar.ts";
export default function (pi: ExtensionAPI) {
	registerStatusBar(pi);
}
