export class KillRing {
  readonly #entries: string[] = [];

  push(value: string, options: { prepend: boolean; accumulate?: boolean }): void {
    if (value.length === 0) return;
    if (options.accumulate && this.#entries.length > 0) {
      const current = this.#entries.pop()!;
      this.#entries.push(options.prepend ? value + current : current + value);
    } else {
      this.#entries.push(value);
    }
  }

  peek(): string | undefined {
    return this.#entries.at(-1);
  }

  rotate(): void {
    if (this.#entries.length < 2) return;
    this.#entries.unshift(this.#entries.pop()!);
  }

  get length(): number {
    return this.#entries.length;
  }
}
