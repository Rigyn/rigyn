import { matchesKey } from "../keys.js";
import { Loader } from "./loader.js";
export class CancellableLoader extends Loader {
  aborted = false;
  onAbort?: () => void;
  handleInput(data: string): void {
    if (this.aborted || !matchesKey(data, "escape")) return;
    this.aborted = true;
    this.onAbort?.();
    this.stop();
  }
}
