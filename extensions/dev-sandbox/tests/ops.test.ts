/**
 * Testes das tools ops (read/write/edit/find/ls) via execInSandbox mockado.
 *
 * Cobre: comandos gerados, erro propagado (exit ≠ 0), parse do stat do ls
 * (tipo|tamanho|mtime) e filtragem do readdir.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../bwrap-executor", () => ({ execInSandbox: vi.fn() }));

import { execInSandbox } from "../bwrap-executor";
import { createReadOps } from "../tools/read-ops";
import { createWriteOps } from "../tools/write-ops";
import { createEditOps } from "../tools/edit-ops";
import { createFindOps } from "../tools/find-ops";
import { createLsOps } from "../tools/ls-ops";
import { DEFAULT_CONFIG } from "../types";

const execMock = vi.mocked(execInSandbox);

beforeEach(() => {
  execMock.mockReset();
});

function ok(over: Partial<{ stdout: string; stderr: string; exitCode: number }> = {}) {
  return { stdout: "", stderr: "", exitCode: 0, ...over };
}

// ─── read-ops ─────────────────────────────────────────────────

describe("read-ops", () => {
  it("readFile: cat via bwrap, retorna Buffer do stdout", async () => {
    execMock.mockResolvedValue(ok({ stdout: "conteúdo" }));
    const buf = await createReadOps(DEFAULT_CONFIG, "/p").readFile("/p/x.txt");
    expect(execMock).toHaveBeenCalledWith(DEFAULT_CONFIG, {
      command: ["cat", "/p/x.txt"], cwd: "/p",
    });
    expect(buf.toString()).toBe("conteúdo");
  });

  it("readFile preserva bytes binários (Buffer intacto)", async () => {
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80]);
    execMock.mockResolvedValue(ok({ stdout: bin }));
    const buf = await createReadOps(DEFAULT_CONFIG, "/p").readFile("/p/img.png");
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.equals(bin)).toBe(true);
  });

  it("readFile: exit ≠ 0 → throw com stderr", async () => {
    execMock.mockResolvedValue(ok({ stderr: "permissão negada", exitCode: 1 }));
    await expect(createReadOps(DEFAULT_CONFIG, "/p").readFile("/p/x.txt"))
      .rejects.toThrow(/permissão negada/);
  });

  it("access: exit 0 ok / exit 1 → throw", async () => {
    execMock.mockResolvedValue(ok());
    await expect(createReadOps(DEFAULT_CONFIG, "/p").access("/p/x")).resolves.toBeUndefined();
    execMock.mockResolvedValue(ok({ exitCode: 1 }));
    await expect(createReadOps(DEFAULT_CONFIG, "/p").access("/p/x")).rejects.toThrow();
  });

  it("detectImageMimeType: mapeia MIME conhecido", async () => {
    execMock.mockResolvedValue(ok({ stdout: "image/png\n" }));
    await expect(createReadOps(DEFAULT_CONFIG, "/p").detectImageMimeType("/p/i.png"))
      .resolves.toBe("image/png");
  });

  it("detectImageMimeType: MIME desconhecido → null", async () => {
    execMock.mockResolvedValue(ok({ stdout: "text/plain\n" }));
    await expect(createReadOps(DEFAULT_CONFIG, "/p").detectImageMimeType("/p/i.png"))
      .resolves.toBeNull();
  });

  it("detectImageMimeType: falha interna → null (degradação)", async () => {
    execMock.mockRejectedValue(new Error("bwrap sumiu"));
    await expect(createReadOps(DEFAULT_CONFIG, "/p").detectImageMimeType("/p/i.png"))
      .resolves.toBeNull();
  });
});

// ─── write-ops ────────────────────────────────────────────────

describe("write-ops", () => {
  it("writeFile: mkdir + cat com stdin", async () => {
    execMock.mockResolvedValue(ok());
    await createWriteOps(DEFAULT_CONFIG, "/p").writeFile("/p/sub/x.txt", "dados");
    const [, call] = execMock.mock.calls[0];
    expect(call.stdin).toBe("dados");
    expect(call.command[0]).toBe("bash");
    expect((call.command[2] as string)).toContain('mkdir -p "$(dirname "$1")" && cat > "$1"');
  });

  it("writeFile: exit ≠ 0 → throw", async () => {
    execMock.mockResolvedValue(ok({ stderr: "disco cheio", exitCode: 1 }));
    await expect(createWriteOps(DEFAULT_CONFIG, "/p").writeFile("/p/x", "d"))
      .rejects.toThrow(/disco cheio/);
  });

  it("mkdir: mkdir -p", async () => {
    execMock.mockResolvedValue(ok());
    await createWriteOps(DEFAULT_CONFIG, "/p").mkdir("/p/sub");
    expect(execMock).toHaveBeenCalledWith(DEFAULT_CONFIG, {
      command: ["mkdir", "-p", "/p/sub"], cwd: "/p",
    });
  });
});

// ─── edit-ops (composição) ────────────────────────────────────

describe("edit-ops", () => {
  it("delega readFile para read-ops", async () => {
    execMock.mockResolvedValue(ok({ stdout: "x" }));
    const ops = createEditOps(DEFAULT_CONFIG, "/p");
    expect((await ops.readFile("/p/x")).toString()).toBe("x");
    expect(await ops.access("/p/x")).toBeUndefined();
  });

  it("delega writeFile para write-ops", async () => {
    execMock.mockResolvedValue(ok());
    await createEditOps(DEFAULT_CONFIG, "/p").writeFile("/p/x", "y");
    expect(execMock).toHaveBeenCalled();
  });
});

// ─── find-ops ─────────────────────────────────────────────────

describe("find-ops", () => {
  it("exists: exit 0 → true, exit 1 → false", async () => {
    execMock.mockResolvedValue(ok());
    await expect(createFindOps(DEFAULT_CONFIG, "/p").exists("/p/x")).resolves.toBe(true);
    execMock.mockResolvedValue(ok({ exitCode: 1 }));
    await expect(createFindOps(DEFAULT_CONFIG, "/p").exists("/p/x")).resolves.toBe(false);
  });

  it("glob: find com filtros e head -n limit", async () => {
    execMock.mockResolvedValue(ok({ stdout: "src/a.ts\nsrc/b.ts\n" }));
    const found = await createFindOps(DEFAULT_CONFIG, "/p").glob("*.ts", "/p", { limit: 7 });
    expect(found).toEqual(["src/a.ts", "src/b.ts"]);
    const [, call] = execMock.mock.calls[0];
    const script = call.command[2] as string;
    expect(script).toContain("-not -path '*/.git/*'");
    expect(script).toContain("-not -path '*/node_modules/*'");
    expect(script).toContain("head -n 7");
    expect(call.command[4]).toBe("/p"); // searchCwd
    expect(call.command[5]).toBe("*.ts"); // pattern
  });

  it("glob: stdout vazio → lista vazia", async () => {
    execMock.mockResolvedValue(ok({ stdout: "" }));
    await expect(createFindOps(DEFAULT_CONFIG, "/p").glob("*.ts", "/p", { limit: 10 }))
      .resolves.toEqual([]);
  });
});

// ─── ls-ops ───────────────────────────────────────────────────

describe("ls-ops — stat parse", () => {
  it("arquivo regular: tipo, tamanho e mtime", async () => {
    execMock.mockResolvedValue(ok({ stdout: "regular file|123|1700000000\n" }));
    const st = await createLsOps(DEFAULT_CONFIG, "/p").stat("/p/x");
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.size).toBe(123);
    expect(st.mtimeMs).toBe(1700000000000);
  });

  it("arquivo vazio: regular empty file → isFile", async () => {
    execMock.mockResolvedValue(ok({ stdout: "regular empty file|0|1700000000\n" }));
    const st = await createLsOps(DEFAULT_CONFIG, "/p").stat("/p/x");
    expect(st.isFile()).toBe(true);
  });

  it("symlink → isSymbolicLink", async () => {
    execMock.mockResolvedValue(ok({ stdout: "symbolic link|0|1700000000\n" }));
    const st = await createLsOps(DEFAULT_CONFIG, "/p").stat("/p/link");
    expect(st.isSymbolicLink()).toBe(true);
    expect(st.isFile()).toBe(false);
  });

  it("diretório → isDirectory", async () => {
    execMock.mockResolvedValue(ok({ stdout: "directory|4096|1700000000\n" }));
    const st = await createLsOps(DEFAULT_CONFIG, "/p").stat("/p/dir");
    expect(st.isDirectory()).toBe(true);
  });

  it("stat falha → throw", async () => {
    execMock.mockResolvedValue(ok({ stdout: "", exitCode: 1 }));
    await expect(createLsOps(DEFAULT_CONFIG, "/p").stat("/p/x")).rejects.toThrow();
  });

  it("readdir: split por null-byte, remove . e ..", async () => {
    execMock.mockResolvedValue(ok({ stdout: "a\0b\0.\0..\0\0" }));
    const entries = await createLsOps(DEFAULT_CONFIG, "/p").readdir("/p");
    expect(entries).toEqual(["a", "b"]);
    expect(execMock.mock.calls[0][1].command[0]).toBe("find");
  });

  it("readdir falha → throw", async () => {
    execMock.mockResolvedValue(ok({ exitCode: 2 }));
    await expect(createLsOps(DEFAULT_CONFIG, "/p").readdir("/p")).rejects.toThrow();
  });
});
