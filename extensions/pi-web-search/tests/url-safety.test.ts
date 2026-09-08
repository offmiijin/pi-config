import { describe, expect, it } from "vitest";
import { isPrivateOrLocalHost } from "../url-safety";

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
