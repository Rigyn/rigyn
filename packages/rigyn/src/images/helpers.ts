import { spawn } from "node:child_process";

export interface ResizedImage {
  data: string;
  mimeType: "image/png";
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

export async function convertToPng(data: string, mimeType: string): Promise<{ data: string; mimeType: "image/png" }> {
  if (mimeType === "image/png") return { data, mimeType: "image/png" };
  const { default: sharp } = await import("sharp");
  const converted = await sharp(Buffer.from(data, "base64")).png().toBuffer();
  return { data: converted.toString("base64"), mimeType: "image/png" };
}

export async function resizeImage(
  data: string,
  mimeType: string,
  maxWidth = 2_000,
  maxHeight = 2_000,
): Promise<ResizedImage> {
  const { default: sharp } = await import("sharp");
  const input = Buffer.from(data, "base64");
  const metadata = await sharp(input).metadata();
  if (metadata.width === undefined || metadata.height === undefined) throw new Error("Image dimensions are unavailable");
  const scale = Math.min(1, maxWidth / metadata.width, maxHeight / metadata.height);
  const width = Math.max(1, Math.round(metadata.width * scale));
  const height = Math.max(1, Math.round(metadata.height * scale));
  const converted = mimeType === "image/png" && scale === 1
    ? input
    : await sharp(input).resize({ width, height, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return {
    data: converted.toString("base64"),
    mimeType: "image/png",
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    width,
    height,
    wasResized: scale < 1,
  };
}

export function formatDimensionNote(image: ResizedImage): string | undefined {
  if (!image.wasResized) return undefined;
  const scale = image.width === 0 ? 1 : image.originalWidth / image.width;
  return `[Resized image: ${image.originalWidth}x${image.originalHeight} -> ${image.width}x${image.height}. Multiply displayed coordinates by ${scale.toFixed(2)} for the source image.]`;
}

interface CopyToClipboardOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

async function pipeClipboard(command: string, args: string[], text: string, signal?: AbortSignal): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, signal });
    child.once("error", (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? resolve(false) : reject(error));
    child.once("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

export async function copyToClipboard(text: string, options: CopyToClipboardOptions = {}): Promise<void> {
  if (text === "") throw new Error("There is no text to copy");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > 75_000) throw new RangeError("Clipboard text exceeds the 75,000-byte terminal fallback limit");
  options.signal?.throwIfAborted();
  const platform = options.platform ?? process.platform;
  if (platform === "darwin" && await pipeClipboard("pbcopy", [], text, options.signal)) return;
  if (platform === "win32" && await pipeClipboard("clip.exe", [], text, options.signal)) return;
  if (platform === "linux") {
    if (await pipeClipboard("wl-copy", [], text, options.signal)) return;
    if (await pipeClipboard("xclip", ["-selection", "clipboard"], text, options.signal)) return;
  }
  options.signal?.throwIfAborted();
  process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`);
}
