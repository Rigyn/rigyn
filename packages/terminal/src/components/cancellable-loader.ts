import { getKeybindings } from "../keybindings.js";
import { Loader } from "./loader.js";
export class CancellableLoader extends Loader {
  readonly #controller = new AbortController(); onAbort?: () => void;
  get signal(): AbortSignal { return this.#controller.signal; } get aborted(): boolean { return this.signal.aborted; }
  handleInput(data: string): void { if (getKeybindings().matches(data, "tui.select.cancel")) { this.#controller.abort(); this.onAbort?.(); } }
  dispose(): void { this.stop(); }
}
