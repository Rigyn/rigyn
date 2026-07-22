import { execFileSync } from "node:child_process";

export type ImageProtocol = "kitty" | "iterm2" | null;
export interface TerminalCapabilities { images: ImageProtocol; trueColor: boolean; hyperlinks: boolean }
export interface CellDimensions { widthPx: number; heightPx: number }
export interface ImageDimensions { widthPx: number; heightPx: number }
export interface ImageRenderOptions { maxWidthCells?: number; maxHeightCells?: number; preserveAspectRatio?: boolean; imageId?: number; moveCursor?: boolean }
export interface ImageCellSize { columns: number; rows: number }

let capabilities: TerminalCapabilities | undefined;
let cells: CellDimensions = { widthPx: 9, heightPx: 18 };
export function getCellDimensions(): CellDimensions { return { ...cells }; }
export function setCellDimensions(value: CellDimensions): void { cells = { ...value }; }

function tmuxHyperlinks(): boolean {
  try {
    return execFileSync("tmux", ["display-message", "-p", "#{client_termfeatures}"], { encoding: "utf8", timeout: 250, stdio: ["ignore", "pipe", "ignore"] }).split(",").map((item) => item.trim()).includes("hyperlinks");
  } catch { return false; }
}

export function detectCapabilities(tmuxProbe: () => boolean = tmuxHyperlinks): TerminalCapabilities {
  const program = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
  const emulator = process.env.TERMINAL_EMULATOR?.toLowerCase() ?? "";
  const term = process.env.TERM?.toLowerCase() ?? "";
  const trueColor = ["truecolor", "24bit"].includes(process.env.COLORTERM?.toLowerCase() ?? "");
  if (process.env.TMUX || term.startsWith("tmux")) return { images: null, trueColor, hyperlinks: tmuxProbe() };
  if (term.startsWith("screen")) return { images: null, trueColor, hyperlinks: false };
  if (process.env.KITTY_WINDOW_ID || program === "kitty" || program === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR || process.env.WEZTERM_PANE || program === "wezterm" || program === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) return { images: "kitty", trueColor: true, hyperlinks: true };
  if (process.env.ITERM_SESSION_ID || program === "iterm.app") return { images: "iterm2", trueColor: true, hyperlinks: true };
  if (process.env.WT_SESSION || ["vscode", "alacritty"].includes(program)) return { images: null, trueColor: true, hyperlinks: true };
  if (emulator === "jetbrains-jediterm") return { images: null, trueColor: true, hyperlinks: false };
  return { images: null, trueColor, hyperlinks: false };
}
export function getCapabilities(): TerminalCapabilities { return capabilities ??= detectCapabilities(); }
export function resetCapabilitiesCache(): void { capabilities = undefined; }
export function setCapabilities(value: TerminalCapabilities): void { capabilities = { ...value }; }

export function isImageLine(line: string): boolean { return line.includes("\x1b_G") || line.includes("\x1b]1337;File="); }
export function allocateImageId(): number { return Math.floor(Math.random() * 0xfffffffe) + 1; }

export function encodeKitty(data: string, options: { columns?: number; rows?: number; imageId?: number; moveCursor?: boolean } = {}): string {
  const parameters = ["a=T", "f=100", "q=2"];
  if (options.moveCursor === false) parameters.push("C=1");
  if (options.columns) parameters.push(`c=${options.columns}`);
  if (options.rows) parameters.push(`r=${options.rows}`);
  if (options.imageId) parameters.push(`i=${options.imageId}`);
  const chunks = data.match(/.{1,4096}/gsu) ?? [""];
  if (chunks.length === 1) return `\x1b_G${parameters.join(",")};${chunks[0]}\x1b\\`;
  return chunks.map((chunk, index) => index === 0 ? `\x1b_G${parameters.join(",")},m=1;${chunk}\x1b\\` : `\x1b_Gm=${index === chunks.length - 1 ? 0 : 1};${chunk}\x1b\\`).join("");
}
export function deleteKittyImage(id: number): string { return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`; }
export function deleteAllKittyImages(): string { return "\x1b_Ga=d,d=A,q=2\x1b\\"; }

export function encodeITerm2(data: string, options: { width?: number | string; height?: number | string; name?: string; preserveAspectRatio?: boolean; inline?: boolean } = {}): string {
  const parameters = [`inline=${options.inline === false ? 0 : 1}`];
  if (options.width !== undefined) parameters.push(`width=${options.width}`);
  if (options.height !== undefined) parameters.push(`height=${options.height}`);
  if (options.name) parameters.push(`name=${Buffer.from(options.name).toString("base64")}`);
  if (options.preserveAspectRatio === false) parameters.push("preserveAspectRatio=0");
  return `\x1b]1337;File=${parameters.join(";")}:${data}\x07`;
}

export function calculateImageCellSize(image: ImageDimensions, maxWidthCells: number, maxHeightCells?: number, cell: CellDimensions = cells): ImageCellSize {
  const maxWidth = Math.max(1, Math.floor(maxWidthCells));
  const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
  const widthScale = maxWidth * cell.widthPx / Math.max(1, image.widthPx);
  const heightScale = maxHeight === undefined ? widthScale : maxHeight * cell.heightPx / Math.max(1, image.heightPx);
  const scale = Math.min(widthScale, heightScale);
  return {
    columns: Math.max(1, Math.min(maxWidth, Math.ceil(image.widthPx * scale / cell.widthPx))),
    rows: Math.max(1, maxHeight === undefined ? Math.ceil(image.heightPx * scale / cell.heightPx) : Math.min(maxHeight, Math.ceil(image.heightPx * scale / cell.heightPx))),
  };
}
export function calculateImageRows(image: ImageDimensions, width: number, cell: CellDimensions = cells): number { return calculateImageCellSize(image, width, undefined, cell).rows; }

function bytes(data: string): Buffer | undefined { try { return Buffer.from(data, "base64"); } catch { return undefined; } }
export function getPngDimensions(data: string): ImageDimensions | null {
  const value = bytes(data); if (!value || value.length < 24 || value.readUInt32BE(0) !== 0x89504e47) return null;
  return { widthPx: value.readUInt32BE(16), heightPx: value.readUInt32BE(20) };
}
export function getGifDimensions(data: string): ImageDimensions | null {
  const value = bytes(data); if (!value || value.length < 10 || !["GIF87a", "GIF89a"].includes(value.subarray(0, 6).toString("ascii"))) return null;
  return { widthPx: value.readUInt16LE(6), heightPx: value.readUInt16LE(8) };
}
export function getJpegDimensions(data: string): ImageDimensions | null {
  const value = bytes(data); if (!value || value.length < 4 || value[0] !== 0xff || value[1] !== 0xd8) return null;
  for (let offset = 2; offset + 9 < value.length;) {
    if (value[offset] !== 0xff) { offset += 1; continue; }
    const marker = value[offset + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2) return { widthPx: value.readUInt16BE(offset + 7), heightPx: value.readUInt16BE(offset + 5) };
    if (offset + 3 >= value.length) break;
    const length = value.readUInt16BE(offset + 2); if (length < 2) break; offset += length + 2;
  }
  return null;
}
export function getWebpDimensions(data: string): ImageDimensions | null {
  const value = bytes(data); if (!value || value.length < 30 || value.toString("ascii", 0, 4) !== "RIFF" || value.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = value.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { widthPx: value.readUInt16LE(26) & 0x3fff, heightPx: value.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") { const bits = value.readUInt32LE(21); return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >> 14) & 0x3fff) + 1 }; }
  if (chunk === "VP8X") return { widthPx: (value[24]! | value[25]! << 8 | value[26]! << 16) + 1, heightPx: (value[27]! | value[28]! << 8 | value[29]! << 16) + 1 };
  return null;
}
export function getImageDimensions(data: string, mimeType: string): ImageDimensions | null {
  return mimeType === "image/png" ? getPngDimensions(data) : mimeType === "image/jpeg" ? getJpegDimensions(data) : mimeType === "image/gif" ? getGifDimensions(data) : mimeType === "image/webp" ? getWebpDimensions(data) : null;
}
export function renderImage(data: string, dimensions: ImageDimensions, options: ImageRenderOptions = {}): { sequence: string; rows: number; imageId?: number } | null {
  const protocol = getCapabilities().images;
  if (!protocol) return null;
  const size = calculateImageCellSize(dimensions, options.maxWidthCells ?? 80, options.maxHeightCells, cells);
  if (protocol === "kitty") return { sequence: encodeKitty(data, { columns: size.columns, rows: size.rows, ...(options.imageId ? { imageId: options.imageId } : {}), ...(options.moveCursor !== undefined ? { moveCursor: options.moveCursor } : {}) }), rows: size.rows, ...(options.imageId ? { imageId: options.imageId } : {}) };
  return { sequence: encodeITerm2(data, { width: size.columns, height: "auto", preserveAspectRatio: options.preserveAspectRatio ?? true }), rows: size.rows };
}
export function hyperlink(text: string, url: string): string { return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`; }
export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
  return `[Image: ${[filename, `[${mimeType}]`, dimensions ? `${dimensions.widthPx}x${dimensions.heightPx}` : undefined].filter(Boolean).join(" ")}]`;
}
