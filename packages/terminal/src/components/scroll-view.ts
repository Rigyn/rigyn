import { scheduleTimeout, type ManagedTimeout, validateTimerDelay } from "../internal-timer.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";
import { assertViewportTextRows, VIEWPORT_COMPONENT, VIEWPORT_POINTER_REGIONS, VIEWPORT_POINTER_TARGET, type ViewportComponent, type ViewportPointerEvent, type ViewportPointerRegion, type ViewportPointerRegionComponent, type ViewportPointerResponse, type ViewportPointerTarget } from "../viewport.js";
export type ScrollbarVisibility = "never" | "auto" | "always";
export interface ScrollViewScrollbar { visibility?: ScrollbarVisibility }
export interface ScrollViewOptions { follow?: "none" | "end"; overscroll?: "contain" | "chain"; scrollbar?: ScrollbarVisibility; scrollbarHideDelayMs?: number; primary?: boolean }
export class ScrollView implements ViewportComponent, ViewportPointerTarget, ViewportPointerRegionComponent {
  readonly [VIEWPORT_COMPONENT] = true as const;
  readonly [VIEWPORT_POINTER_TARGET] = true as const;
  readonly [VIEWPORT_POINTER_REGIONS] = true as const;
  scrollTop = 0;
  isFollowingEnd: boolean;
  isScrollbarVisible = false;
  readonly #hideDelay: number;
  #timer: ManagedTimeout | undefined;
  #height = 0;
  #contentHeight = 0;
  #requestRender: (() => void) | undefined;
  #dragging = false;
  #width = 0;
  #paintPending = false;
  constructor(readonly child: Component, readonly options: ScrollViewOptions = {}) { this.isFollowingEnd = options.follow === "end"; this.#hideDelay = validateTimerDelay(options.scrollbarHideDelayMs === undefined ? 800 : options.scrollbarHideDelayMs, "scrollbar hide delay"); }
  render(width: number): string[] { return this.child.render(width); }
  renderViewport(width: number, height: number, requestRender?: () => void): string[] {
    const columns = Math.max(0, Math.trunc(width)); this.#width = columns; this.#height = Math.max(0, Math.trunc(height)); this.#requestRender = requestRender; this.#paintPending = false;
    const all = this.child.render(columns); assertViewportTextRows(all); this.#contentHeight = all.length;
    const maximum = Math.max(0, all.length - this.#height);
    if (this.isFollowingEnd) this.scrollTop = maximum; else this.scrollTop = Math.max(0, Math.min(this.scrollTop, maximum));
    const visible = all.slice(this.scrollTop, this.scrollTop + this.#height).map((line) => truncateToWidth(line, columns, "", true));
    while (visible.length < this.#height) visible.push(" ".repeat(columns));
    if (this.isScrollbarVisible && maximum > 0 && columns > 0) {
      const thumb = Math.min(this.#height - 1, Math.floor(this.scrollTop / maximum * Math.max(0, this.#height - 1)));
      visible[thumb] = `${truncateToWidth(visible[thumb]!, columns - 1, "", true)}\x1b[7m \x1b[0m`;
    }
    return visible;
  }
  scrollBy(rows: number): number {
    const maximum = Math.max(0, this.#contentHeight - this.#height);
    const requested = this.scrollTop + rows;
    const next = Math.max(0, Math.min(maximum, requested));
    const used = next - this.scrollTop; this.scrollTop = next;
    if (rows < 0) this.isFollowingEnd = false; else if (next === maximum) this.isFollowingEnd = this.options.follow === "end";
    this.#requestRender?.();
    return this.options.overscroll === "chain" ? rows - used : 0;
  }
  scrollToStart(): void { this.scrollTop = 0; this.isFollowingEnd = false; this.#requestRender?.(); }
  scrollToEnd(): void { this.scrollTop = Math.max(0, this.#contentHeight - this.#height); this.isFollowingEnd = true; this.#requestRender?.(); }
  viewportPointerRegions(): readonly ViewportPointerRegion[] { return [{ component: this.child, row: -this.scrollTop, column: 0, width: this.#width, height: this.#contentHeight }]; }
  setScrollbarActive(active: boolean): void { this.#timer?.clear(); if (active) { const changed = !this.isScrollbarVisible && this.options.scrollbar !== "never"; this.isScrollbarVisible = this.options.scrollbar !== "never"; if (changed && this.#requestRender !== undefined) { this.#paintPending = true; this.#requestRender(); } return; } if (this.options.scrollbar !== "auto") return; this.#timer = scheduleTimeout(() => { this.isScrollbarVisible = false; if (!this.#paintPending) this.#requestRender?.(); }, this.#hideDelay); this.#timer.unref(); }
  handleViewportPointer(event: ViewportPointerEvent, width: number, height: number): ViewportPointerResponse {
    if (event.type === "wheel") return { handled: true, remainingRows: this.scrollBy(event.deltaRows ?? 0) };
    const onBar = event.column === width - 1;
    if (event.type === "move" && !this.#dragging) { this.setScrollbarActive(onBar); return { handled: onBar }; }
    if (event.type === "press" && onBar && event.button === "left") { this.#dragging = true; this.setScrollbarActive(true); return { handled: true, capture: true }; }
    if (event.type === "move" && this.#dragging) { const maximum = Math.max(0, this.#contentHeight - height); this.scrollTop = Math.round(Math.max(0, Math.min(height - 1, event.row)) / Math.max(1, height - 1) * maximum); this.#requestRender?.(); return { handled: true }; }
    if (event.type === "release" && this.#dragging) { this.#dragging = false; return { handled: true, releaseCapture: true }; }
    if (event.type === "cancel" || event.type === "leave") { this.#dragging = false; return { releaseCapture: true }; }
    return { handled: false };
  }
  dispose(): void { this.#timer?.clear(); }
  invalidate(): void { this.child.invalidate(); }
}
