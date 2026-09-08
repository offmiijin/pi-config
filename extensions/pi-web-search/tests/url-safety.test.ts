import { describe, expect, it, vi } from "vitest";
import { assertPublicUrl, fetchWithSafeRedirects, isPrivateOrLocalHost } from "../url-safety";

describe("isPrivateOrLocalHost", () => {
  it.each(["localhost", "service.local", "127.0.0.1", "10.0.0.8", "192.168.1.2", "169.254.169.254", "::1", "fd00::1"]) (
    "bloqueia %s",
    (host) => expect(isPrivateOrLocalHost(host)).toBe(true),
  );

  it.each(["example.com", "8.8.8.8", "2001:4860:4860::8888"])(
    "permite %s",
    (host) => expect(isPrivateOrLocalHost(host)).toBe(false),
  );
});

describe("fetchWithSafeRedirects", () => {
  it("revalida o destino de um redirect", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 302, headers: { get: () => "http://127.0.0.1/admin" } })
      .mockResolvedValueOnce({ status: 200, headers: { get: () => null } });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithSafeRedirects("https://example.com", {})).rejects.toThrow("hosts locais");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("recusa esquemas e credenciais", () => {
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow("HTTP(S)");
    expect(() => assertPublicUrl("https://user:pass@example.com")).toThrow("credenciais");
  });
});
