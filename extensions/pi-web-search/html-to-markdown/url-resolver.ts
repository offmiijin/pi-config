/**
 * Resolução e validação de URLs (Fase 1 — links e imagens).
 *
 * Regras globais do contrato:
 *   - URLs relativas são resolvidas contra a baseUrl (URL final da página)
 *   - Protocolos aceitos: ALLOWED_PROTOCOLS (https/http/mailto/tel)
 *   - Qualquer outro (javascript:, data:, file:, ...) → null (sem link)
 */

import { ALLOWED_PROTOCOLS } from "./types";

export function resolveUrl(
	raw: string | undefined,
	baseUrl: string,
	allowedProtocols: readonly string[] = ALLOWED_PROTOCOLS,
): string | null {
	if (!raw) return null;
	const href = raw.trim().replace(/[\u0000-\u001f\u007f]/g, "");
	if (!href) return null;

	// Esquema explícito (https:, javascript:, mailto:, tel:, ...)
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
	if (scheme) {
		const proto = `${scheme}:`;
		if (!allowedProtocols.includes(proto)) return null;
		return href;
	}

	// Relativo (inclui fragmentos "#x" e protocolo-relativo "//host") →
	// resolve contra a baseUrl
	if (!baseUrl) return null;
	try {
		return new URL(href, baseUrl).href;
	} catch {
		return null;
	}
}
