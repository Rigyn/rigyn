import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import targets from "../native/targets.json" with { type: "json" };

const expected = new Set(["darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"]);
if (targets.schemaVersion !== 1 || !Array.isArray(targets.targets)) throw new Error("invalid native target manifest");
if (targets.targets.length !== expected.size) throw new Error("native target manifest must contain four release targets");

for (const target of targets.targets) {
  const key = `${target.platform}-${target.arch}`;
  if (!expected.delete(key)) throw new Error(`unexpected or duplicate native target: ${key}`);
  const source = await readFile(target.source, "utf8");
  if (!source.includes("napi_register_module_v1")) throw new Error(`native source does not declare an N-API entry point: ${target.source}`);
}
if (expected.size > 0) throw new Error(`native targets are missing: ${[...expected].join(", ")}`);

const release = process.argv.includes("--release");
const local = targets.targets.find((target) => target.platform === process.platform && target.arch === process.arch);
const selected = release ? targets.targets : local ? [local] : [];
for (const target of selected) {
  let metadata;
  try {
    metadata = await stat(target.output);
  } catch {
    throw new Error(`required native artifact is missing: ${target.output}`);
  }
  if (!metadata.isFile() || metadata.size < 512) throw new Error(`native artifact is invalid: ${target.output}`);
  const header = await readFile(target.output);
  const executable = target.platform === "win32"
    ? header[0] === 0x4d && header[1] === 0x5a
    : [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(header.readUInt32BE(0));
  if (!executable) throw new Error(`native artifact has an unexpected executable header: ${target.output}`);
}

if (local) {
  const require = createRequire(import.meta.url);
  const helper = require(fileURLToPath(new URL(`../${local.output}`, import.meta.url)));
  const value = process.platform === "darwin" ? helper.isModifierPressed?.("shift") : helper.enableVirtualTerminalInput?.();
  if (typeof value !== "boolean") throw new Error(`native helper did not return a boolean: ${local.output}`);
  console.log(`native source, layout, and runtime verified for ${process.platform}-${process.arch}`);
} else {
  console.log(`native source and four-target release layout verified; runtime loading requires a macOS or Windows host (current: ${process.platform}-${process.arch})`);
}

if (release) console.log("all native release artifacts verified");
