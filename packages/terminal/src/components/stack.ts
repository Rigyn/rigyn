import type { Component } from "../tui.js";

export interface StackEntryOptions {
  basis?: number;
  grow?: number;
  shrink?: number;
  minSize?: number;
  maxSize?: number;
  visible?: (size: { width: number; height: number }) => boolean;
}
export interface StackEntry extends StackEntryOptions { component: Component }
export type StackChild = Component | StackEntry;
export interface StackOptions { gap?: number; align?: "stretch" | "start" | "center" | "end" }

function entry(value: StackChild): StackEntry {
  return "component" in value ? value : { component: value };
}

export class Stack implements Component {
  readonly children: StackEntry[];
  readonly gap: number;
  readonly align: NonNullable<StackOptions["align"]>;

  constructor(children: readonly StackChild[] = [], options: StackOptions = {}) {
    this.children = children.map(entry);
    this.gap = Math.max(0, Math.trunc(options.gap ?? 0));
    this.align = options.align ?? "stretch";
  }

  entriesFor(size: { width: number; height: number }): StackEntry[] {
    return this.children.filter((selected) => selected.visible?.(size) !== false);
  }

  addChild(component: Component, options: StackEntryOptions = {}): void { this.children.push({ component, ...options }); }
  removeChild(component: Component): void { const index = this.children.findIndex((child) => child.component === component); if (index >= 0) this.children.splice(index, 1); }
  clear(): void { this.children.length = 0; }
  render(width: number): string[] { return this.children.flatMap(({ component }) => component.render(width)); }
  handleInput(data: string): void { this.children.at(-1)?.component.handleInput?.(data); }
  invalidate(): void { for (const child of this.children) child.component.invalidate(); }
}

export function resolveStackSizes(entries: readonly StackEntry[], intrinsic: readonly number[], gap: number, available: number): number[] {
  if (entries.length === 0) return [];
  const room = Math.max(0, available - Math.max(0, entries.length - 1) * gap);
  const sizes = entries.map((selected, index) => Math.max(selected.minSize ?? 0, Math.min(selected.maxSize ?? Number.MAX_SAFE_INTEGER, selected.basis ?? intrinsic[index] ?? 0)));
  let total = sizes.reduce((sum, value) => sum + value, 0);
  if (total < room) {
    const weights = entries.map((selected) => Math.max(0, selected.grow ?? 0));
    let weight = weights.reduce((sum, value) => sum + value, 0);
    if (weight === 0) weight = 1;
    let remaining = room - total;
    entries.forEach((selected, index) => {
      const share = index === entries.length - 1 ? remaining : Math.floor((room - total) * (weights[index] ?? 0) / weight);
      const next = Math.min(selected.maxSize ?? Number.MAX_SAFE_INTEGER, sizes[index]! + share);
      remaining -= next - sizes[index]!;
      sizes[index] = next;
    });
  } else if (total > room) {
    let excess = total - room;
    while (excess > 0) {
      const candidates = entries.map((selected, index) => ({ index, weight: selected.shrink ?? 1 })).filter(({ index, weight }) => weight > 0 && sizes[index]! > (entries[index]!.minSize ?? 0));
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        if (excess === 0) break;
        sizes[candidate.index] = sizes[candidate.index]! - 1;
        excess -= 1;
      }
    }
  }
  total = sizes.reduce((sum, value) => sum + value, 0);
  if (total > room) sizes[sizes.length - 1] = Math.max(0, sizes.at(-1)! - (total - room));
  return sizes.map((value) => Math.max(0, Math.trunc(value)));
}
