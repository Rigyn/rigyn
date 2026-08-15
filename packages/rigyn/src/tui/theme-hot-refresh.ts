import { createHash } from "node:crypto";
import { lstatSync, watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { errorMessage } from "../core/errors.js";
import { readTrustedTextFileSync } from "../core/resource-file.js";
import type { ExtensionTheme } from "../extensions/types.js";
import { readFileBounded } from "../tools/paths.js";
import { parseThemeDefinition, type ThemeDefinition } from "./theme.js";
import { byteTruncate, sanitizeTerminalText } from "./unicode.js";

const MAX_THEME_BYTES = 1024 * 1024;
const REFRESH_DEBOUNCE_MS = 100;

function callbackError(value: unknown): Error {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  if (isError?.(value) === true) return value as Error;
  return new Error(byteTruncate(sanitizeTerminalText(errorMessage(value)), 4_096), { cause: value });
}

function fileSignature(sourcePath: string): string | undefined {
  try {
    const information = lstatSync(sourcePath);
    if (information.isFile() && information.size <= MAX_THEME_BYTES) {
      return createHash("sha256")
        .update(readTrustedTextFileSync(sourcePath, MAX_THEME_BYTES, "Theme"))
        .digest("hex");
    }
    return `${information.ino}:${information.size}:${information.mtimeMs}`;
  } catch {
    return undefined;
  }
}

export interface ThemeHotRefreshCallbacks {
  apply(definition: ThemeDefinition): void;
  invalid?(error: Error): void;
}

/** Watches only the selected loose theme and keeps its last valid definition active. */
export class ThemeHotRefresher {
  readonly #callbacks: ThemeHotRefreshCallbacks;
  #watcher: FSWatcher | undefined;
  #timer: NodeJS.Timeout | undefined;
  #selected: Pick<ExtensionTheme, "name" | "sourcePath"> | undefined;
  #signature: string | undefined;
  #generation = 0;

  constructor(callbacks: ThemeHotRefreshCallbacks) {
    this.#callbacks = callbacks;
  }

  select(theme: Pick<ExtensionTheme, "name" | "sourcePath"> | undefined): void {
    if (
      theme !== undefined
      && this.#selected !== undefined
      && this.#watcher !== undefined
      && theme.name === this.#selected.name
      && theme.sourcePath === this.#selected.sourcePath
    ) return;
    this.#stop();
    this.#selected = theme === undefined ? undefined : { name: theme.name, sourcePath: theme.sourcePath };
    if (this.#selected === undefined) return;
    const selected = this.#selected;
    const generation = this.#generation;
    this.#signature = fileSignature(selected.sourcePath);
    try {
      this.#watcher = watch(dirname(selected.sourcePath), { persistent: false }, (_event, filename) => {
        if (generation !== this.#generation) return;
        if (filename !== null && filename.toString() !== basename(selected.sourcePath)) return;
        this.#schedule(generation);
      });
      this.#watcher.on("error", () => {
        if (generation === this.#generation) this.#stop();
      });
      this.#schedule(generation);
    } catch {
      this.#watcher = undefined;
    }
  }

  close(): void {
    this.#selected = undefined;
    this.#stop();
  }

  #schedule(generation: number): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const selected = this.#selected;
      if (selected === undefined || generation !== this.#generation) return;
      const signature = fileSignature(selected.sourcePath);
      if (signature === this.#signature) return;
      this.#signature = signature;
      void this.#refresh(generation);
    }, REFRESH_DEBOUNCE_MS);
    this.#timer.unref();
  }

  async #refresh(generation: number): Promise<void> {
    const selected = this.#selected;
    if (selected === undefined || generation !== this.#generation) return;
    try {
      const information = await lstat(selected.sourcePath);
      if (!information.isFile() || information.size > MAX_THEME_BYTES) return;
      const source = await readFileBounded(selected.sourcePath, MAX_THEME_BYTES + 1);
      if (source.truncated || source.totalBytes > MAX_THEME_BYTES || generation !== this.#generation) return;
      const definition = parseThemeDefinition(JSON.parse(source.data.toString("utf8")) as unknown);
      if (definition.name !== selected.name || generation !== this.#generation) return;
      this.#callbacks.apply(definition);
    } catch (cause) {
      try { this.#callbacks.invalid?.(callbackError(cause)); }
      catch { /* A diagnostic observer must not reject the background refresh. */ }
    }
  }

  #stop(): void {
    this.#generation += 1;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#signature = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
  }
}
