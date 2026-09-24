import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDocumentTool } from "./tool";
import { registerClipboardPathBridge } from "./clipboard-bridge";

export {
	DEFAULT_PDF_TEXT_TIMEOUT_MS,
	extractPdfText,
	isPdftotextAvailable,
	resetPdftotextAvailability,
} from "./pdf-text";
export type { ExtractPdfTextOptions } from "./pdf-text";
export {
	DEFAULT_MINIMUM_TEXT_LENGTH,
	DEFAULT_OCR_DPI,
	DEFAULT_OCR_LANGUAGES,
	DEFAULT_OCR_MAX_PAGES,
	DEFAULT_OCR_TIMEOUT_MS,
	hasSufficientText,
	isImageFile,
	ocrPdf,
	recognizeImage,
} from "./ocr";
export type { OcrOptions } from "./ocr";

export default function (pi: ExtensionAPI): void {
	registerDocumentTool(pi);
	registerClipboardPathBridge(pi);
}
