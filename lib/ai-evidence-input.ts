/**
 * Server-side document preparation for the AI Evidence Copilot.
 *
 * The provider never receives the original PDF. Raster uploads are normalized
 * to a bounded JPEG and PDFs are rendered, one page at a time, to bounded
 * JPEGs. This also strips image metadata before any opt-in provider request.
 */
import { Buffer } from "node:buffer";

import { createCanvas, DOMMatrix, ImageData, loadImage, Path2D } from "@napi-rs/canvas";

import type { AiEvidenceInputMode, DocumentType } from "./types";

const MAX_AI_PAGES = 6;
const MAX_RENDER_EDGE = 1_400;
const MAX_RENDER_PIXELS = 1_600_000;
const MAX_SOURCE_IMAGE_EDGE = 10_000;
const MAX_SOURCE_IMAGE_PIXELS = 25_000_000;
const MAX_PAGE_TEXT_CHARACTERS = 10_000;
const MAX_TOTAL_TEXT_CHARACTERS = 48_000;
const MAX_PDF_IMAGE_PIXELS = 4_000_000;
const PDF_PREPARATION_TIMEOUT_MS = 20_000;
const JPEG_QUALITY = 82;

export interface AiEvidencePageInput {
  page: number;
  text?: string;
  imageDataUrl: string;
}

export interface AiEvidencePreparedInput {
  documentType: DocumentType;
  inputMode: AiEvidenceInputMode;
  sourcePageCount: number;
  pages: AiEvidencePageInput[];
  warnings: string[];
}

class AiInputPreparationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AiInputPreparationError";
  }
}

function installPdfCanvasGlobals(): void {
  const runtime = globalThis as unknown as Record<string, unknown>;
  // PDF.js discovers these browser primitives while evaluating its Node build.
  // @napi-rs/canvas supplies native, server-side implementations.
  runtime.DOMMatrix = DOMMatrix;
  runtime.ImageData = ImageData;
  runtime.Path2D = Path2D;
}

async function loadPdfJs() {
  installPdfCanvasGlobals();
  const runtime = globalThis as typeof globalThis & {
    pdfjsWorker?: { WorkerMessageHandler: unknown };
  };
  // The legacy build carries the ES collection-method polyfills required by
  // Render's supported Node 22 runtime.
  // @ts-expect-error pdfjs-dist does not publish a declaration for its worker entrypoint.
  const workerModule = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  runtime.pdfjsWorker ??= { WorkerMessageHandler: workerModule.WorkerMessageHandler };
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

function cleanText(value: string): string {
  return value
    .replaceAll("\u0000", "")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/ +/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textContentToString(items: ReadonlyArray<unknown>): string {
  let output = "";
  for (const candidate of items) {
    if (!candidate || typeof candidate !== "object" || !("str" in candidate)) continue;
    const item = candidate as { str?: unknown; hasEOL?: unknown };
    if (typeof item.str !== "string") continue;
    output += item.str;
    output += item.hasEOL === true ? "\n" : " ";
  }
  return output;
}

function boundedDimensions(width: number, height: number): { width: number; height: number } {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new AiInputPreparationError("AI_INPUT_INVALID_DIMENSIONS");
  }
  const scale = Math.min(
    1,
    MAX_RENDER_EDGE / Math.max(width, height),
    Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if (startOfFrame.has(marker) && length >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
}

function assertSafeSourceImage(bytes: Uint8Array, contentType: string): void {
  const dimensions = contentType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (!dimensions) throw new AiInputPreparationError("AI_INPUT_INVALID_IMAGE");
  if (
    dimensions.width > MAX_SOURCE_IMAGE_EDGE ||
    dimensions.height > MAX_SOURCE_IMAGE_EDGE ||
    dimensions.width * dimensions.height > MAX_SOURCE_IMAGE_PIXELS
  ) {
    throw new AiInputPreparationError("AI_INPUT_IMAGE_TOO_LARGE");
  }
}

function jpegDataUrl(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

async function prepareImage(
  bytes: Uint8Array,
  contentType: string,
  documentType: DocumentType,
): Promise<AiEvidencePreparedInput> {
  assertSafeSourceImage(bytes, contentType);
  const image = await loadImage(Buffer.from(bytes));
  const output = boundedDimensions(image.width, image.height);
  const canvas = createCanvas(output.width, output.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(image, 0, 0, output.width, output.height);
  const normalized = canvas.toBuffer("image/jpeg", JPEG_QUALITY);
  return {
    documentType,
    inputMode: "IMAGE",
    sourcePageCount: 1,
    pages: [{ page: 1, imageDataUrl: jpegDataUrl(normalized) }],
    warnings: [],
  };
}

async function preparePdf(
  bytes: Uint8Array,
  documentType: DocumentType,
): Promise<AiEvidencePreparedInput> {
  const { getDocument, VerbosityLevel } = await loadPdfJs();
  // PDF.js may transfer the supplied ArrayBuffer to its worker.
  const loadingTask = getDocument({
    data: bytes.slice(),
    canvasMaxAreaInBytes: 16 * 1024 * 1024,
    disableFontFace: true,
    enableXfa: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
    stopAtErrors: true,
    useWasm: false,
    useSystemFonts: true,
    verbosity: VerbosityLevel.ERRORS,
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void loadingTask.destroy();
  }, PDF_PREPARATION_TIMEOUT_MS);
  const pages: AiEvidencePageInput[] = [];
  let remainingText = MAX_TOTAL_TEXT_CHARACTERS;
  let sourcePageCount = 0;
  try {
    const pdf = await loadingTask.promise;
    sourcePageCount = pdf.numPages;
    const pagesToRender = Math.min(sourcePageCount, MAX_AI_PAGES);
    for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        const output = boundedDimensions(baseViewport.width, baseViewport.height);
        const scale = Math.min(
          output.width / baseViewport.width,
          output.height / baseViewport.height,
        );
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          viewport,
          background: "#ffffff",
        }).promise;

        let text: string | undefined;
        if (remainingText > 0) {
          const content = await page.getTextContent({ disableNormalization: false });
          const cleaned = cleanText(textContentToString(content.items)).slice(
            0,
            Math.min(MAX_PAGE_TEXT_CHARACTERS, remainingText),
          );
          if (cleaned) {
            text = cleaned;
            remainingText -= cleaned.length;
          }
        }
        const jpeg = canvas.toBuffer("image/jpeg", JPEG_QUALITY);
        pages.push({ page: pageNumber, text, imageDataUrl: jpegDataUrl(jpeg) });
      } finally {
        page.cleanup();
      }
    }
  } catch (error) {
    if (timedOut) throw new AiInputPreparationError("AI_INPUT_PDF_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
    await loadingTask.destroy();
  }
  if (!pages.length) throw new AiInputPreparationError("AI_INPUT_NO_PAGES");
  const warnings: string[] = [];
  if (sourcePageCount > MAX_AI_PAGES) {
    warnings.push(`AI review was bounded to the first ${MAX_AI_PAGES} pages.`);
  }
  if (remainingText === 0) {
    warnings.push("AI page text reached its safety limit; rendered pages were still supplied.");
  }
  return {
    documentType,
    inputMode: "PDF_RENDERED_PAGES",
    sourcePageCount,
    pages,
    warnings,
  };
}

export async function prepareAiEvidenceInput(
  bytes: Uint8Array,
  contentType: string,
  documentType: DocumentType,
): Promise<AiEvidencePreparedInput> {
  if (contentType === "image/png" || contentType === "image/jpeg") {
    return prepareImage(bytes, contentType, documentType);
  }
  if (contentType === "application/pdf") return preparePdf(bytes, documentType);
  throw new AiInputPreparationError("AI_INPUT_UNSUPPORTED_TYPE");
}

export const aiEvidenceInputLimits = {
  maximumPages: MAX_AI_PAGES,
  maximumRenderEdge: MAX_RENDER_EDGE,
  maximumRenderPixels: MAX_RENDER_PIXELS,
  maximumTextCharacters: MAX_TOTAL_TEXT_CHARACTERS,
} as const;
