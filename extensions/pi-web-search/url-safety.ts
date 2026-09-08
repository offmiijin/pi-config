import { isIP } from "node:net";

export function assertPublicUrl(value: string): URL {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("somente URLs HTTP(S) sem credenciais são permitidas");
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error("acesso a hosts locais ou redes privadas não é permitido");
  }
  return parsed;
}

/** Segue redirects manualmente, revalidando cada destino contra SSRF. */
export async function fetchWithSafeRedirects(
  value: string,
  init: RequestInit,
  maxRedirects = 5,
): Promise<Response> {
  let current = assertPublicUrl(value).toString();
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirect === maxRedirects) throw new Error("quantidade máxima de redirects excedida");
    current = assertPublicUrl(new URL(location, current).toString()).toString();
  }
  throw new Error("quantidade máxima de redirects excedida");
}

/** Retorna true para endereços que não devem ser acessados pelo coletor web. */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "local" || host.endsWith(".local")) return true;
  if (host === "metadata.google.internal" || host === "instance-data.ec2.internal") return true;

  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
      a >= 224;
  }
  if (version === 6) {
    const normalized = host.toLowerCase();
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.");
  }
  return false;
}
