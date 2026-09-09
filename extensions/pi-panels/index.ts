/**
 * Pi Panels — painéis TUI independentes para alterações Git e uso de tokens.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerChangesPanel from "./changes/index.ts";
import registerTokenMonitor from "./token-monitor/index.ts";

export default function (pi: ExtensionAPI): void {
	registerChangesPanel(pi);
	registerTokenMonitor(pi);
}
