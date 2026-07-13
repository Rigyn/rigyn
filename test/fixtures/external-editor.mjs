import { writeFile } from "node:fs/promises";

const path = process.argv.at(-1);
if (path === undefined) throw new Error("missing editor path");
if (process.env.HARNESS_EDITOR_MARKER !== undefined) {
  await writeFile(process.env.HARNESS_EDITOR_MARKER, path, "utf8");
}
await writeFile(path, "edited by fixture\n", "utf8");
