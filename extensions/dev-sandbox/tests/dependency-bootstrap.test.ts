/** Testes do diagnóstico de bootstrap offline de dependências. */

import { describe, it, expect } from "vitest";
import { dependencyBootstrapHint } from "../dependency-bootstrap";

describe("dependencyBootstrapHint", () => {
  it("orienta bootstrap npm quando cache está vazio", () => {
    const hint = dependencyBootstrapHint(
      "npm install --offline",
      "npm error code ENOTCACHED\nnpm error no cached response",
    );

    expect(hint).toContain("sandbox_fetch");
    expect(hint).toContain("npm install ./pacote.tgz");
  });

  it("orienta bootstrap pip para wheel local", () => {
    const hint = dependencyBootstrapHint(
      "python3 -m pip install requests",
      "ERROR: No matching distribution found for requests",
    );

    expect(hint).toContain("artifacts");
    expect(hint).toContain("python -m pip install ./pacote.whl");
  });

  it("não adiciona orientação para comandos comuns ou falhas não relacionadas", () => {
    expect(dependencyBootstrapHint("npm test", "test failed")).toBeUndefined();
    expect(dependencyBootstrapHint("npm install", "permission denied")).toBeUndefined();
  });
});
