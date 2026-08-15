import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";

export type ImageProtocol = "kitty" | "iterm2";
export interface TerminalCapabilities { images: ImageProtocol | null; trueColor: boolean; hyperlinks: boolean }
export interface ImageDimensions { widthPx: number; heightPx: number }
export interface CellDimensions { widthPx: number; heightPx: number }
export interface ImageCellSize { columns: number; rows: number }
export interface ImageRenderOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
  imageId?: number;
  moveCursor?: boolean;
}

let selectedCapabilities: TerminalCapabilities | undefined;
let selectedCellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };
let imageId = 1;

export function detectCapabilities(commandExists: (command: string) => boolean = () => false): TerminalCapabilities {
  const tmux = process.env.TMUX !== undefined;
  const term = (process.env.TERM ?? "").toLowerCase();
  const program = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  const images = tmux ? null : term.includes("kitty") || program === "ghostty" ? "kitty" : program === "iterm.app" ? "iterm2" : null;
  const trueColor = !tmux && ((process.env.COLORTERM ?? "").toLowerCase().includes("truecolor") || images !== null);
  const hyperlinks = tmux ? commandExists("tmux") : program !== "linux";
  return { images, trueColor, hyperlinks };
}

export function setCapabilities(value: TerminalCapabilities): void { selectedCapabilities = { ...value }; }
export function getCapabilities(): TerminalCapabilities { return selectedCapabilities ??= detectCapabilities(); }
export function resetCapabilitiesCache(): void { selectedCapabilities = undefined; }
export function setCellDimensions(value: CellDimensions): void { selectedCellDimensions = { ...value }; }
export function getCellDimensions(): CellDimensions { return { ...selectedCellDimensions }; }
export function allocateImageId(): number { const value = imageId; imageId = imageId >= 0x7fffffff ? 1 : imageId + 1; return value; }

function bytes(base64: string): Buffer { try { return Buffer.from(base64, "base64"); } catch { return Buffer.alloc(0); } }

export function getPngDimensions(value: string): ImageDimensions | null {
  const data = bytes(value);
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { widthPx: data.readUInt32BE(16), heightPx: data.readUInt32BE(20) };
}

export function getGifDimensions(value: string): ImageDimensions | null {
  const data = bytes(value);
  if (data.length < 10 || !/^GIF8[79]a$/u.test(data.subarray(0, 6).toString("ascii"))) return null;
  return { widthPx: data.readUInt16LE(6), heightPx: data.readUInt16LE(8) };
}

export function getJpegDimensions(value: string): ImageDimensions | null {
  const data = bytes(value);
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { widthPx: data.readUInt16BE(offset + 7), heightPx: data.readUInt16BE(offset + 5) };
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) break;
    offset += 2 + length;
  }
  return null;
}

export function getWebpDimensions(value: string): ImageDimensions | null {
  const data = bytes(value);
  if (data.length < 30 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") return null;
  if (data.toString("ascii", 12, 16) === "VP8X") {
    return {
      widthPx: 1 + data[24]! + (data[25]! << 8) + (data[26]! << 16),
      heightPx: 1 + data[27]! + (data[28]! << 8) + (data[29]! << 16),
    };
  }
  return null;
}

export function getImageDimensions(value: string, mimeType: string): ImageDimensions | null {
  return mimeType === "image/png" ? getPngDimensions(value)
    : mimeType === "image/gif" ? getGifDimensions(value)
      : mimeType === "image/jpeg" ? getJpegDimensions(value)
        : mimeType === "image/webp" ? getWebpDimensions(value)
          : null;
}

export function calculateImageCellSize(
  dimensions: ImageDimensions,
  maxColumns: number,
  maxRows?: number,
  cells: CellDimensions = selectedCellDimensions,
): ImageCellSize {
  const availableColumns = Math.max(1, Math.floor(maxColumns));
  const naturalColumns = Math.max(1, Math.ceil(dimensions.widthPx / cells.widthPx));
  const naturalRows = Math.max(1, Math.ceil(dimensions.heightPx / cells.heightPx));
  const scale = Math.min(1, availableColumns / naturalColumns, maxRows === undefined ? 1 : Math.max(1, maxRows) / naturalRows);
  return { columns: Math.max(1, Math.floor(naturalColumns * scale)), rows: Math.max(1, Math.floor(naturalRows * scale)) };
}

export function calculateImageRows(dimensions: ImageDimensions, columns: number, cells: CellDimensions = selectedCellDimensions): number {
  return calculateImageCellSize(dimensions, columns, undefined, cells).rows;
}

export function encodeKitty(data: string, options: { columns: number; rows: number; imageId?: number; moveCursor?: boolean }): string {
  const chunks = data.match(/.{1,4096}/gu) ?? [""];
  const prefix = `a=T,f=100,q=2${options.moveCursor === false ? ",C=1" : ""},c=${options.columns},r=${options.rows}${options.imageId === undefined ? "" : `,i=${options.imageId}`}`;
  return chunks.map((chunk, index) => `\x1b_G${index === 0 ? `${prefix},` : ""}m=${index + 1 < chunks.length ? 1 : 0};${chunk}\x1b\\`).join("");
}

export function encodeITerm2(data: string, options: { columns: number; rows: number; filename?: string }): string {
  const name = options.filename === undefined ? "" : `;name=${Buffer.from(options.filename).toString("base64")}`;
  return `\x1b]1337;File=inline=1;width=${options.columns};height=${options.rows}${name}:${data}\x07`;
}

export function isImageLine(value: string): boolean { return value.includes("\x1b_G") || value.includes("\x1b]1337;File=inline=1"); }
export function deleteKittyImage(id: number): string { return `\x1b_Ga=d,d=I,i=${id}\x1b\\`; }
export function deleteAllKittyImages(): string { return "\x1b_Ga=d,d=A\x1b\\"; }

export function hyperlink(text: string, target: string): string {
  return getCapabilities().hyperlinks ? `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
  let display = filename;
  if (filename !== undefined && isAbsolute(filename)) {
    const home = homedir();
    const inside = relative(home, filename);
    if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) display = `~/${inside.replaceAll("\\", "/")}`;
    if (getCapabilities().hyperlinks) display = hyperlink(display ?? filename, pathToFileURL(filename).href);
  }
  const label = [display, `[${mimeType}]`, dimensions === undefined ? undefined : `${dimensions.widthPx}x${dimensions.heightPx}`].filter(Boolean).join(" ");
  return `[Image: ${label}]`;
}

export function renderImage(data: string, mimeType: string, width: number, options: ImageRenderOptions = {}, dimensions?: ImageDimensions): string[] {
  const size = dimensions === undefined ? { columns: Math.max(1, width), rows: 1 } : calculateImageCellSize(
    dimensions,
    Math.min(width, options.maxWidthCells ?? width),
    options.maxHeightCells,
  );
  const capabilities = getCapabilities();
  if (capabilities.images === "kitty" && mimeType === "image/png") {
    return [encodeKitty(data, { ...size, imageId: options.imageId ?? allocateImageId(), ...(options.moveCursor === undefined ? {} : { moveCursor: options.moveCursor }) }), ...Array.from({ length: size.rows - 1 }, () => "")];
  }
  if (capabilities.images === "iterm2") return [...Array.from({ length: size.rows - 1 }, () => ""), encodeITerm2(data, { ...size, ...(options.filename === undefined ? {} : { filename: options.filename }) })];
  return [imageFallback(mimeType, dimensions, options.filename)];
}
