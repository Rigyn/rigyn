import type { Component } from "../tui.js";
import { getImageDimensions, renderImage, type ImageDimensions, type ImageRenderOptions } from "../terminal-image.js";
import { truncateToWidth } from "../utils.js";
export interface ImageTheme { fallbackColor: (value: string) => string }
export type ImageOptions = ImageRenderOptions;
export class Image implements Component {
  constructor(readonly data: string, readonly mimeType: string, readonly theme: ImageTheme, readonly options: ImageOptions = {}, readonly dimensions?: ImageDimensions) {}
  render(width: number): string[] {
    const dimensions = this.dimensions ?? getImageDimensions(this.data, this.mimeType) ?? undefined;
    const lines = renderImage(this.data, this.mimeType, width, { moveCursor: false, ...this.options }, dimensions);
    return lines.map((line) => line === "" || line.includes("\x1b_G") || line.includes("\x1b]1337;") ? line : this.theme.fallbackColor(truncateToWidth(line, width)));
  }
  invalidate(): void {}
}
