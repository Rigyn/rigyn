import { allocateImageId, getCapabilities, getCellDimensions, getImageDimensions, type ImageDimensions, imageFallback, renderImage } from "../terminal-image.js";
import type { Component } from "../tui.js";
export interface ImageTheme { fallbackColor: (text: string) => string }
export interface ImageOptions { maxWidthCells?: number; maxHeightCells?: number; filename?: string; imageId?: number }
export class Image implements Component {
  readonly #dimensions: ImageDimensions; #id: number | undefined; #cache: { width: number; lines: string[] } | undefined;
  constructor(private data: string, private mimeType: string, private theme: ImageTheme, private options: ImageOptions = {}, dimensions?: ImageDimensions) { this.#dimensions = dimensions ?? getImageDimensions(data, mimeType) ?? { widthPx: 800, heightPx: 600 }; this.#id = options.imageId; }
  getImageId(): number | undefined { return this.#id; }
  invalidate(): void { this.#cache = undefined; }
  render(width: number): string[] {
    if (this.#cache?.width === width) return this.#cache.lines; const maximum = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60)); const cell = getCellDimensions(); const maxHeight = this.options.maxHeightCells ?? Math.max(1, Math.ceil(maximum * cell.widthPx / cell.heightPx));
    if (getCapabilities().images === "kitty" && this.#id === undefined) this.#id = allocateImageId(); const image = renderImage(this.data, this.#dimensions, { maxWidthCells: maximum, maxHeightCells: maxHeight, ...(this.#id ? { imageId: this.#id } : {}), moveCursor: false });
    let lines: string[]; if (!image) lines = [this.theme.fallbackColor(imageFallback(this.mimeType, this.#dimensions, this.options.filename))]; else if (getCapabilities().images === "kitty") lines = [image.sequence, ...Array.from({ length: image.rows - 1 }, () => "")]; else { const up = image.rows > 1 ? `\x1b[${image.rows - 1}A` : ""; lines = [...Array.from({ length: image.rows - 1 }, () => ""), up + image.sequence]; }
    this.#cache = { width, lines }; return lines;
  }
}
