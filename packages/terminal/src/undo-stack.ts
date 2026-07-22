export class UndoStack<State> {
  readonly #states: State[] = [];

  push(state: State): void {
    this.#states.push(structuredClone(state));
  }

  pop(): State | undefined {
    return this.#states.pop();
  }

  clear(): void {
    this.#states.length = 0;
  }

  get length(): number {
    return this.#states.length;
  }
}
