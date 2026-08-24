import { describe, expect, it } from "vitest";
import { getSandboxArgumentCompletions } from "../command-completions";

describe("sandbox — autocomplete", () => {
  it("sugere info no nível superior", () => {
    expect(getSandboxArgumentCompletions("")?.map((item) => item.value)).toEqual(["info"]);
    expect(getSandboxArgumentCompletions("in")).toEqual([
      expect.objectContaining({ value: "info" }),
    ]);
  });

  it("não sugere comandos desconhecidos", () => {
    expect(getSandboxArgumentCompletions("set")).toBeNull();
    expect(getSandboxArgumentCompletions("unknown")).toBeNull();
  });
});
