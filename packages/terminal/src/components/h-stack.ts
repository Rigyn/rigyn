import { compositeTerminalLine } from "../compositor.js";
import { visibleWidth } from "../utils.js";
import {
  assertViewportTextRows,
  isViewportComponent,
  renderViewport,
  VIEWPORT_COMPONENT,
  VIEWPORT_POINTER_REGIONS,
  type ViewportComponent,
  type ViewportPointerRegion,
  type ViewportPointerRegionComponent,
} from "../viewport.js";
import { resolveStackSizes, Stack, type StackOptions } from "./stack.js";

function verticalOffset(align: NonNullable<StackOptions["align"]>, freeRows: number): number {
  if (align === "end") return freeRows;
  if (align === "center") return Math.floor(freeRows / 2);
  return 0;
}

export class HStack extends Stack implements ViewportComponent, ViewportPointerRegionComponent {
  readonly [VIEWPORT_COMPONENT] = true as const;
  readonly [VIEWPORT_POINTER_REGIONS] = true as const;
  #pointerRegions: ViewportPointerRegion[] = [];

  viewportPointerRegions(): readonly ViewportPointerRegion[] { return this.#pointerRegions; }

  override render(width: number): string[] {
    return this.compose(Math.max(0, Math.trunc(width)));
  }

  renderViewport(width: number, height: number, requestRender?: () => void): string[] {
    return this.compose(
      Math.max(0, Math.trunc(width)),
      Math.max(0, Math.trunc(height)),
      requestRender,
    );
  }

  private compose(width: number, fixedHeight?: number, requestRender?: () => void): string[] {
    if (width === 0 || fixedHeight === 0) return [];
    const entries = this.entriesFor({ width, height: fixedHeight ?? Number.MAX_SAFE_INTEGER });
    if (entries.length === 0) {
      return fixedHeight === undefined ? [] : Array.from({ length: fixedHeight }, () => " ".repeat(width));
    }

    const natural = entries.map(({ component }) => component.render(width));
    for (const lines of natural) assertViewportTextRows(lines);
    const intrinsicWidths = natural.map((lines) => lines.reduce(
      (maximum, line) => Math.max(maximum, visibleWidth(line)),
      0,
    ));
    const childWidths = resolveStackSizes(entries, intrinsicWidths, this.gap, width);
    const allocated = entries.map(({ component }, index) =>
      childWidths[index] === 0 ? [] : component.render(childWidths[index]!));
    const naturalHeight = allocated.reduce((maximum, lines) => Math.max(maximum, lines.length), 0);
    const rowCount = fixedHeight ?? naturalHeight;
    const rows = Array.from({ length: rowCount }, () => " ".repeat(width));
    this.#pointerRegions = [];

    let column = 0;
    entries.forEach(({ component }, index) => {
      const childWidth = childWidths[index]!;
      if (childWidth === 0) {
        column += this.gap;
        return;
      }
      this.#pointerRegions.push({ component, row: 0, column, width: childWidth, height: rowCount });

      let childLines: string[];
      let offset = 0;
      if (fixedHeight !== undefined && isViewportComponent(component)) {
        childLines = renderViewport(component, childWidth, fixedHeight, requestRender);
      } else {
        childLines = allocated[index]!.slice(0, rowCount);
        offset = verticalOffset(this.align, Math.max(0, rowCount - childLines.length));
      }
      assertViewportTextRows(childLines);
      for (let line = 0; line < childLines.length && line + offset < rowCount; line += 1) {
        const target = line + offset;
        rows[target] = compositeTerminalLine(rows[target]!, childLines[line]!, column, childWidth, width);
      }
      column += childWidth + this.gap;
    });
    return rows;
  }
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.js";
