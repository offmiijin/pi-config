import { describe, expect, it, vi } from "vitest";
import { registerDocumentTool } from "./tool";

describe("document_extract", () => {
	it("registra a tool com caminho local de imagem ou PDF", () => {
		const registerTool = vi.fn();
		registerDocumentTool({ registerTool } as never);

		expect(registerTool).toHaveBeenCalledOnce();
		expect(registerTool.mock.calls[0][0]).toMatchObject({
			name: "document_extract",
			label: "Document Text Extraction",
		});
		expect(typeof registerTool.mock.calls[0][0].execute).toBe("function");
	});
});
