import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const path = process.argv[2];
if (path === undefined || resolve(path) === fileURLToPath(import.meta.url)) throw new Error("missing editor path");
if (process.env.HARNESS_EDITOR_MARKER !== undefined) {
  await writeFile(process.env.HARNESS_EDITOR_MARKER, path, "utf8");
}
await writeFile(path, "edited by fixture\n", "utf8");
