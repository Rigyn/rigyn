import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../src/cli/args.js";
import { applyRuntimeExtensionFlags, resolveRuntimeExtensionFlags } from "../../src/cli/extension-flags.js";
import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { sha256 } from "../../src/tools/hash.js";

const definitions = [
  { extensionId: "fixture", sourcePath: "/fixture.mjs", name: "plan", type: "boolean" as const, default: false },
  { extensionId: "fixture", sourcePath: "/fixture.mjs", name: "custom-mode", type: "string" as const, default: "normal" },
];

test("runtime extension flags are parsed after discovery without consuming a boolean flag's prompt", () => {
  const source = ["--plan", "--custom-mode", "safe", "inspect", "workspace"];
  const bootstrap = parseArguments(source, { deferUnknown: true });
  assert.deepEqual(bootstrap.deferredFlags, ["plan", "custom-mode"]);

  const resolved = resolveRuntimeExtensionFlags(bootstrap.source, definitions);
  assert.equal(resolved.arguments.command, "run");
  assert.deepEqual(resolved.arguments.positionals, ["inspect", "workspace"]);
  assert.deepEqual([...resolved.values], [["plan", true], ["custom-mode", "safe"]]);
});

test("runtime flag parsing preserves built-in precedence and rejects unknown or malformed values", () => {
  assert.throws(
    () => resolveRuntimeExtensionFlags(["--provider", "fixture", "--provider", "other", "prompt"], definitions),
    /more than once/u,
  );
  assert.throws(() => resolveRuntimeExtensionFlags(["--unknown", "prompt"], definitions), /Unknown flag --unknown/u);
  assert.throws(() => resolveRuntimeExtensionFlags(["--plan=maybe", "prompt"], definitions), /true or false/u);
  assert.throws(() => resolveRuntimeExtensionFlags(["prompt"], [{ ...definitions[0]!, name: "model" }]), /conflicts with a built-in/u);
});

test("explicit false and omitted values remain distinct from extension defaults", () => {
  const explicit = resolveRuntimeExtensionFlags(["--plan=false", "prompt"], definitions);
  assert.equal(explicit.values.get("plan"), false);
  const omitted = resolveRuntimeExtensionFlags(["prompt"], definitions);
  assert.equal(omitted.values.has("plan"), false);
});

test("resolved CLI values are visible to extension lifecycle handlers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-extension-flags-"));
  t.after(async () => {
    delete (globalThis as Record<string, unknown>).__extensionFlagFixture;
    await rm(root, { recursive: true, force: true });
  });
  const source = `export default (api) => {
    api.registerFlag({ name: "plan", type: "boolean", default: false });
    api.registerFlag({ name: "custom-mode", type: "string", default: "normal" });
    api.on("session_start", () => { globalThis.__extensionFlagFixture = [api.getFlag("plan"), api.getFlag("custom-mode")]; });
  };\n`;
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{ extensionId: "fixture", sourcePath, sha256: sha256(source) }], { workspace: root });
  const parsed = applyRuntimeExtensionFlags(parseArguments(["--plan", "--custom-mode", "strict"], { deferUnknown: true }), host);
  assert.equal(parsed.command, "run");
  await host.dispatch("session_start", { threadId: "thread", workspace: root });
  assert.deepEqual((globalThis as Record<string, unknown>).__extensionFlagFixture, [true, "strict"]);
  await host.close();
});
