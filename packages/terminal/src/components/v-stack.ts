import { visibleWidth } from "../utils.js";
import { fitViewportRows, isViewportComponent, renderViewport, VIEWPORT_COMPONENT, VIEWPORT_POINTER_REGIONS, type ViewportComponent, type ViewportPointerRegion, type ViewportPointerRegionComponent } from "../viewport.js";
import { isImageLine } from "../terminal-image.js";
import { resolveStackSizes, Stack, type StackChild, type StackOptions } from "./stack.js";

export class VStack extends Stack implements ViewportComponent, ViewportPointerRegionComponent {
  readonly [VIEWPORT_COMPONENT] = true as const;
  readonly [VIEWPORT_POINTER_REGIONS] = true as const;
  #regions: ViewportPointerRegion[] = [];

  constructor(children: readonly StackChild[] = [], options: StackOptions = {}) { super(children, options); }
  viewportPointerRegions(): readonly ViewportPointerRegion[] { return this.#regions; }

  override render(width: number): string[] {
    const entries = this.entriesFor({ width, height: Number.MAX_SAFE_INTEGER });
    const output: string[] = [];
    entries.forEach(({ component }, index) => {
      output.push(...component.render(width));
      if (index + 1 < entries.length) output.push(...Array.from({ length: this.gap }, () => ""));
    });
    return output;
  }

  renderViewport(width: number, height: number, requestRender?: () => void): string[] {
    const columns = Math.max(0, Math.trunc(width));
    const rows = Math.max(0, Math.trunc(height));
    const entries = this.entriesFor({ width: columns, height: rows });
    const natural = entries.map(({ component }) => component.render(columns).length);
    const sizes = resolveStackSizes(entries, natural, this.gap, rows);
    const output: string[] = [];
    this.#regions = [];
    let row = 0;
    entries.forEach(({ component }, index) => {
      const childHeight = sizes[index]!;
      this.#regions.push({ component, row, column: 0, width: columns, height: childHeight });
      const childRows = isViewportComponent(component)
        ? renderViewport(component, columns, childHeight, requestRender)
        : fitViewportRows(component.render(columns), columns, childHeight);
      if (this.align !== "stretch" && this.align !== "start") {
        const aligned = childRows.map((line) => {
          if (isImageLine(line)) return line;
          const free = Math.max(0, columns - visibleWidth(line.trimEnd()));
          const offset = this.align === "end" ? free : Math.floor(free / 2);
          return `${" ".repeat(offset)}${line.trimEnd()}${" ".repeat(free - offset)}`;
        });
        output.push(...aligned);
      } else output.push(...childRows);
      row += childHeight;
      if (index + 1 < entries.length) { output.push(...Array.from({ length: Math.min(this.gap, rows - output.length) }, () => " ".repeat(columns))); row += this.gap; }
    });
    return fitViewportRows(output, columns, rows);
  }
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.js";
