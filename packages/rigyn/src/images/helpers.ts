import { copyToNativeClipboard, type ClipboardTextOptions } from "./clipboard-text.js";
import { preprocessImageInProcess } from "./preprocess-core.js";

export interface ImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
}

export interface ResizedImage {
  data: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

export async function resizeImage(
  inputBytes: Uint8Array,
  _mimeType: string,
  options: ImageResizeOptions = {},
): Promise<ResizedImage | null> {
  try {
    const image = await preprocessImageInProcess(inputBytes, {
      ...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
      ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
      ...(options.maxBytes === undefined ? {} : { maxOutputBytes: options.maxBytes }),
      ...(options.jpegQuality === undefined ? {} : { jpegQuality: options.jpegQuality }),
    });
    return {
      data: Buffer.from(image.bytes).toString("base64"),
      mimeType: image.mediaType,
      originalWidth: image.coordinates.originalWidth,
      originalHeight: image.coordinates.originalHeight,
      width: image.coordinates.width,
      height: image.coordinates.height,
      wasResized: image.coordinates.resized || image.coordinates.converted,
    };
  } catch {
    return null;
  }
}

export function formatDimensionNote(result: ResizedImage): string | undefined {
  if (!result.wasResized) return undefined;
  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

export async function convertToPng(
  base64Data: string,
  mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
  if (mimeType === "image/png") return { data: base64Data, mimeType };
  try {
    const { default: sharp } = await import("sharp");
    const bytes = await sharp(Buffer.from(base64Data, "base64"), {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    }).autoOrient().png().toBuffer();
    return { data: bytes.toString("base64"), mimeType: "image/png" };
  } catch {
    return null;
  }
}

export async function copyToClipboard(text: string, options: ClipboardTextOptions = {}): Promise<void> {
  let copied = false;
  try {
    copied = await copyToNativeClipboard(text, options) !== undefined;
  } catch {
    // Fall through to the terminal clipboard protocol.
  }
  options.signal?.throwIfAborted();
  const environment = options.environment ?? process.env;
  const remote = Boolean(environment.SSH_CONNECTION || environment.SSH_CLIENT || environment.MOSH_CONNECTION);
  if (copied && !remote) return;
  const encoded = Buffer.from(text).toString("base64");
  if (encoded.length <= 100_000) {
    process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
    copied = true;
  }
  if (!copied) throw new Error("Failed to copy to clipboard");
}
