import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ModifierKey = "shift" | "command" | "control" | "option";
type Helper = { isModifierPressed(name: ModifierKey): boolean };
let cached: Helper | null | undefined;

function helper(): Helper | undefined {
  if (cached !== undefined) return cached ?? undefined;
  cached = null;
  if (process.platform !== "darwin" || !["x64", "arm64"].includes(process.arch)) return undefined;
  const local = dirname(fileURLToPath(import.meta.url));
  const relative = join("native", "darwin", "prebuilds", `darwin-${process.arch}`, "darwin-modifiers.node");
  const require = createRequire(import.meta.url);
  for (const candidate of [join(local, "..", relative), join(local, relative), join(dirname(process.execPath), relative)]) {
    try {
      const loaded = require(candidate) as Partial<Helper>;
      if (typeof loaded.isModifierPressed === "function") return cached = loaded as Helper;
    } catch { /* try next release layout */ }
  }
  return undefined;
}

export function isNativeModifierPressed(name: ModifierKey): boolean {
  try { return helper()?.isModifierPressed(name) === true; } catch { return false; }
}
