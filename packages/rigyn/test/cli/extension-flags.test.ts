import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../src/cli/args.js";
import { applyRuntimeExtensionFlags, resolveRuntimeExtensionFlags } from "../../src/cli/extension-flags.js";
import { sha256 } from "../../src/tools/hash.js";
import { loadTestDirectExtensions } from "../helpers/direct-extension-loader.js";

const definitions = [
  { extensionId: "fixture", sourcePath: "/fixture.mjs", name: "plan", type: "boolean" as const, default: false },
  { extensionId: "fixture", sourcePath: "/fixture.mjs", name: "custom-mode", type: "string" as const, default: "normal" },
];

test("runtime extension flags are parsed after discovery without consuming a boolean flag's prompt", () => {
  const source = ["--plan", "--custom-mode", "safe", "inspect", "workspace"];
  const bootstrap = parseArgs(source);
  const resolved = resolveRuntimeExtensionFlags(bootstrap.unknownFlags, definitions);
  assert.deepEqual(bootstrap.messages, ["inspect", "workspace"]);
  assert.deepEqual([...resolved.values], [["plan", true], ["custom-mode", "safe"]]);
  assert.deepEqual(resolved.diagnostics, []);
});

test("runtime flag resolution reports unknown flags and missing string values", () => {
  const unknown = resolveRuntimeExtensionFlags(parseArgs(["--unknown", "prompt"]).unknownFlags, definitions);
  assert.match(unknown.diagnostics[0]?.message ?? "", /Unknown option/u);
  const missing = resolveRuntimeExtensionFlags(parseArgs(["--custom-mode"]).unknownFlags, definitions);
  assert.match(missing.diagnostics[0]?.message ?? "", /requires a value/u);
});

test("boolean extension flags are enabled by presence while omitted values retain defaults", () => {
  const explicit = resolveRuntimeExtensionFlags(parseArgs(["--plan=false", "prompt"]).unknownFlags, definitions);
  assert.equal(explicit.values.get("plan"), true);
  const omitted = resolveRuntimeExtensionFlags(parseArgs(["prompt"]).unknownFlags, definitions);
  assert.equal(omitted.values.has("plan"), false);
});

test("resolved CLI values are visible to extension lifecycle handlers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-extension-flags-"));
  t.after(async () => {
    delete (globalThis as Record<string, unknown>).__extensionFlagFixture;
    await rm(root, { recursive: true, force: true });
  });
  const source = `export default (api) => {
    api.registerFlag("plan", { type: "boolean", default: false });
    api.registerFlag("custom-mode", { type: "string", default: "normal" });
    api.on("session_start", () => { globalThis.__extensionFlagFixture = [api.getFlag("plan"), api.getFlag("custom-mode")]; });
  };\n`;
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadTestDirectExtensions([{ extensionId: "fixture", sourcePath, sha256: sha256(source) }], { workspace: root });
  const parsed = applyRuntimeExtensionFlags(parseArgs(["--plan", "--custom-mode", "strict"]), host);
  assert.deepEqual(parsed.diagnostics, []);
  await host.dispatch("session_start", { threadId: "thread", reason: "startup" });
  assert.deepEqual((globalThis as Record<string, unknown>).__extensionFlagFixture, [true, "strict"]);
  await host.close();
});
