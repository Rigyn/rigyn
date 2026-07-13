import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface ModelCatalogStore {
  read(maxBytes: number): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

function assertMaxBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Model catalog maximum size must be a positive safe integer");
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class FileModelCatalogStore implements ModelCatalogStore {
  readonly #path: string;

  constructor(path: string) {
    if (path.trim() === "" || path.includes("\0")) throw new Error("Model catalog path must be a non-empty filesystem path");
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  async read(maxBytes: number): Promise<string | undefined> {
    assertMaxBytes(maxBytes);
    let size: number;
    try {
      size = (await stat(this.#path)).size;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (size > maxBytes) throw new Error(`Persisted model catalog exceeds ${maxBytes} bytes`);
    const value = await readFile(this.#path);
    if (value.byteLength > maxBytes) throw new Error(`Persisted model catalog exceeds ${maxBytes} bytes`);
    return value.toString("utf8");
  }

  async write(value: string): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(value, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
      try {
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch (error) {
        if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) {
          throw error;
        }
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
