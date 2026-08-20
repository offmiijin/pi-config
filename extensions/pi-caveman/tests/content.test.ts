import { describe, expect, it } from "vitest";
import { detectContent } from "../content/detector.ts";
import { compressJson } from "../content/compressors/json.ts";
import { compressLog } from "../content/compressors/log.ts";

const noisyLog = Array.from({ length: 100 }, (_, index) =>
	index % 10 === 0 ? `2026-01-01 ERROR falha no item ${index}` : `2026-01-01 INFO polling item ${index}`,
).join("\n");

describe("detector", () => {
	it("reconhece JSON válido", () => {
		expect(detectContent('{\n  "ok": true\n}')).toBe("json");
	});

	it("não classifica JSON inválido como JSON", () => {
		expect(detectContent('{"ok":')).not.toBe("json");
	});

	it("reconhece logs por estrutura e ferramenta", () => {
		expect(detectContent(noisyLog, "bash")).toBe("log");
	});

	it("mantém texto comum como texto", () => {
		expect(detectContent("Uma explicação curta.")).toBe("text");
	});
});

describe("compressor JSON", () => {
	it("minifica JSON preservando a estrutura", () => {
		const original = '{\n  "name": "pi",\n  "items": [1, 2, 3]\n}';
		const result = compressJson(original);
		expect(result?.output).toBe('{"name":"pi","items":[1,2,3]}');
		expect(result?.output.length).toBeLessThan(original.length);
	});

	it("recusa JSON inválido", () => {
		expect(compressJson('{"broken":')).toBeUndefined();
	});
});

describe("compressor de logs", () => {
	it("remove ruído e preserva linhas de erro", () => {
		const result = compressLog(noisyLog);
		expect(result?.output).toContain("ERROR falha");
		expect(result?.output).toContain("linhas de log omitidas");
		expect(result?.output.length).toBeLessThan(noisyLog.length);
	});

	it("não transforma log pequeno", () => {
		expect(compressLog("INFO uma linha\nERROR outra linha")).toBeUndefined();
	});
});
