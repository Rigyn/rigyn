import type { Component } from "./tui.js";
import { isImageLine } from "./terminal-image.js";
import { sliceByColumn, visibleWidth } from "./utils.js";

/** Capability marker for components that can render into a fixed rectangle. */
export const VIEWPORT_COMPONENT: unique symbol = Symbol("rigyn.viewport-component");

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ViewportComponent extends Component {
  readonly [VIEWPORT_COMPONENT]: true;
  renderViewport(width: number, height: number, requestRender?: () => void): string[];
}

/** Pointer input normalized to zero-based terminal cells. */
export interface ViewportPointerEvent {
  type: "press" | "release" | "move" | "wheel" | "leave" | "cancel";
  row: number;
  column: number;
  button: "left" | "middle" | "right" | "none";
  deltaRows?: number;
}

export interface ViewportPointerResponse {
  handled?: boolean;
  capture?: boolean;
  releaseCapture?: boolean;
  remainingRows?: number;
}

/** Capability marker for a component that accepts pointer input. */
export const VIEWPORT_POINTER_TARGET: unique symbol = Symbol("rigyn.viewport-pointer-target");

export interface ViewportPointerTarget extends Component {
  readonly [VIEWPORT_POINTER_TARGET]: true;
  handleViewportPointer(
    event: ViewportPointerEvent,
    width: number,
    height: number,
  ): ViewportPointerResponse;
}

export interface ViewportPointerRegion {
  component: Component;
  row: number;
  column: number;
  width: number;
  height: number;
}

/** Last rendered child rectangles used for pointer hit testing. */
export const VIEWPORT_POINTER_REGIONS: unique symbol = Symbol("rigyn.viewport-pointer-regions");

export interface ViewportPointerRegionComponent extends Component {
  readonly [VIEWPORT_POINTER_REGIONS]: true;
  viewportPointerRegions(): readonly ViewportPointerRegion[];
}

export interface ViewportPointerDispatchResult {
  handled: boolean;
  remainingRows: number;
  target?: ViewportPointerTarget;
  capture?: ViewportPointerTarget;
  releaseCapture?: boolean;
}

export function isViewportComponent(component: Component): component is ViewportComponent {
  return VIEWPORT_COMPONENT in component && component[VIEWPORT_COMPONENT] === true;
}

export function isViewportPointerTarget(component: Component): component is ViewportPointerTarget {
  return VIEWPORT_POINTER_TARGET in component && component[VIEWPORT_POINTER_TARGET] === true;
}

function isViewportPointerRegionComponent(component: Component): component is ViewportPointerRegionComponent {
  return VIEWPORT_POINTER_REGIONS in component && component[VIEWPORT_POINTER_REGIONS] === true;
}

interface PointerLocation {
  target: ViewportPointerTarget;
  row: number;
  column: number;
  width: number;
  height: number;
}

function contains(
  row: number,
  column: number,
  region: Pick<ViewportPointerRegion, "row" | "column" | "width" | "height">,
): boolean {
  return row >= region.row
    && column >= region.column
    && row < region.row + region.height
    && column < region.column + region.width;
}

function pointerPath(
  component: Component,
  row: number,
  column: number,
  bounds: Omit<ViewportPointerRegion, "component">,
): PointerLocation[] {
  if (!contains(row, column, bounds)) return [];
  if (isViewportPointerRegionComponent(component)) {
    const regions = component.viewportPointerRegions();
    for (let index = regions.length - 1; index >= 0; index -= 1) {
      const region = regions[index]!;
      const absolute = {
        row: bounds.row + region.row,
        column: bounds.column + region.column,
        width: region.width,
        height: region.height,
      };
      const nested = pointerPath(region.component, row, column, absolute);
      if (nested.length > 0) {
        return isViewportPointerTarget(component)
          ? [...nested, { target: component, ...bounds }]
          : nested;
      }
    }
  }
  return isViewportPointerTarget(component) ? [{ target: component, ...bounds }] : [];
}

function targetLocation(
  component: Component,
  selected: ViewportPointerTarget,
  bounds: Omit<ViewportPointerRegion, "component">,
): PointerLocation | undefined {
  if (component === selected) return { target: selected, ...bounds };
  if (!isViewportPointerRegionComponent(component)) return undefined;
  for (const region of component.viewportPointerRegions()) {
    const found = targetLocation(region.component, selected, {
      row: bounds.row + region.row,
      column: bounds.column + region.column,
      width: region.width,
      height: region.height,
    });
    if (found !== undefined) return found;
  }
  return undefined;
}

function localEvent(event: ViewportPointerEvent, location: PointerLocation): ViewportPointerEvent {
  return {
    ...event,
    row: event.row - location.row,
    column: event.column - location.column,
  };
}

/** Dispatches to the deepest pointer target, then chains unused wheel rows outward. */
export function dispatchViewportPointer(
  component: Component,
  event: ViewportPointerEvent,
  width: number,
  height: number,
  captured?: ViewportPointerTarget,
): ViewportPointerDispatchResult {
  const bounds = {
    row: 0,
    column: 0,
    width: Math.max(0, Math.trunc(width)),
    height: Math.max(0, Math.trunc(height)),
  };
  const capturedLocation = captured === undefined
    ? undefined
    : targetLocation(component, captured, bounds);
  const targets = captured === undefined
    ? pointerPath(component, event.row, event.column, bounds)
    : capturedLocation === undefined ? [] : [capturedLocation];
  let remainingRows = event.deltaRows ?? 0;
  let handled = false;
  let capture: ViewportPointerTarget | undefined;
  let releaseCapture = false;
  let selected: ViewportPointerTarget | undefined;

  for (const location of targets) {
    const response = location.target.handleViewportPointer({
      ...localEvent(event, location),
      ...(event.type === "wheel" ? { deltaRows: remainingRows } : {}),
    }, location.width, location.height);
    selected ??= location.target;
    handled ||= response.handled === true;
    if (response.capture === true) capture = location.target;
    releaseCapture ||= response.releaseCapture === true;
    if (event.type !== "wheel") {
      if (handled || capture !== undefined || capturedLocation !== undefined) break;
      continue;
    }
    remainingRows = response.remainingRows ?? (response.handled === true ? 0 : remainingRows);
    if (remainingRows === 0) break;
  }

  return {
    handled,
    remainingRows,
    ...(selected === undefined ? {} : { target: selected }),
    ...(capture === undefined ? {} : { capture }),
    ...(releaseCapture ? { releaseCapture: true } : {}),
  };
}

export function cancelViewportPointer(
  component: Component,
  target: ViewportPointerTarget,
  width: number,
  height: number,
  type: "leave" | "cancel" = "cancel",
): void {
  const location = targetLocation(component, target, {
    row: 0,
    column: 0,
    width: Math.max(0, Math.trunc(width)),
    height: Math.max(0, Math.trunc(height)),
  });
  if (location === undefined) return;
  target.handleViewportPointer({
    type,
    row: -1,
    column: -1,
    button: "none",
  }, location.width, location.height);
}

export function assertViewportTextRows(lines: readonly string[]): void {
  if (lines.some(isImageLine)) {
    throw new Error("Terminal image rows are not supported in clipped or horizontal layouts");
  }
}

function fitLine(line: string, width: number): string {
  if (isImageLine(line)) return line;
  const clipped = visibleWidth(line) > width ? sliceByColumn(line, 0, width, true) : line;
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function imageRows(line: string): number {
  const value = /(?:^|,)r=(\d+)(?:,|;)/u.exec(line)?.[1];
  return Math.max(1, Number(value ?? 1));
}

export function fitViewportRows(lines: readonly string[], width: number, height: number): string[] {
  const columns = Math.max(0, Math.trunc(width));
  const rows = Math.max(0, Math.trunc(height));
  if (columns === 0 || rows === 0) return [];
  const output: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const line = lines[row] ?? "";
    if (!isImageLine(line)) {
      output.push(fitLine(line, columns));
      continue;
    }
    const reserved = imageRows(line);
    if (reserved > rows - row) {
      output.push(...Array.from({ length: rows - row }, () => " ".repeat(columns)));
      break;
    }
    for (let offset = 1; offset < reserved; offset += 1) {
      const continuation = lines[row + offset] ?? "";
      if (isImageLine(continuation) || visibleWidth(continuation) > 0) {
        throw new Error("Terminal image rows overlap visible viewport content");
      }
    }
    output.push(line, ...Array.from({ length: reserved - 1 }, () => ""));
    row += reserved - 1;
  }
  return output;
}

export function renderViewport(
  component: Component,
  width: number,
  height: number,
  requestRender?: () => void,
): string[] {
  const columns = Math.max(0, Math.trunc(width));
  const rows = Math.max(0, Math.trunc(height));
  if (columns === 0 || rows === 0) return [];
  const output = isViewportComponent(component)
    ? component.renderViewport(columns, rows, requestRender)
    : component.render(columns);
  return fitViewportRows(output, columns, rows);
}
