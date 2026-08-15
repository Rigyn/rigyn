import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageRoot = new URL("../", import.meta.url);

test("Darwin targets package one fixed Security.framework keychain helper per architecture", async () => {
  const manifest = JSON.parse(await readFile(new URL("native/targets.json", packageRoot), "utf8"));
  const darwin = manifest.targets.filter((target) => target.platform === "darwin");
  assert.deepEqual(darwin.map((target) => target.keychain), [
    {
      source: "native/darwin/src/rigyn-keychain-helper.swift",
      output: "native/darwin/prebuilds/darwin-x64/rigyn-keychain-helper",
    },
    {
      source: "native/darwin/src/rigyn-keychain-helper.swift",
      output: "native/darwin/prebuilds/darwin-arm64/rigyn-keychain-helper",
    },
  ]);
});

test("the keychain helper uses a bounded stdin protocol and native Keychain Services", async () => {
  const source = await readFile(
    new URL("native/darwin/src/rigyn-keychain-helper.swift", packageRoot),
    "utf8",
  );
  for (const fragment of [
    "import Security",
    "FileHandle.standardInput",
    "MAX_REQUEST_BYTES",
    "SecItemCopyMatching",
    "SecItemAdd",
    "SecItemUpdate",
    "SecItemDelete",
    "resetBytes",
  ]) assert.ok(source.includes(fragment), `keychain helper source must contain ${fragment}`);
  for (const forbidden of [
    "ProcessInfo.processInfo.environment",
    "UserDefaults.standard",
    "print(",
  ]) assert.equal(source.includes(forbidden), false, `keychain helper source must not contain ${forbidden}`);
});

test("native build and verification compile, protect, and execute the Darwin keychain helper", async () => {
  const [build, verify] = await Promise.all([
    readFile(new URL("scripts/build-native.mjs", packageRoot), "utf8"),
    readFile(new URL("scripts/verify-native.mjs", packageRoot), "utf8"),
  ]);
  for (const fragment of [
    'resolve(dirname(process.execPath), "..", "include", "node")',
    '"-I", nodeHeaders',
    'process.env.SWIFTC || "swiftc"',
    '"-framework", "Security"',
    "target.keychain.source",
    "target.keychain.output",
    "chmod(target.keychain.output, 0o755)",
  ]) assert.ok(build.includes(fragment), `native build must contain ${fragment}`);
  for (const fragment of [
    "target.keychain.output",
    'helper.modifierPressed?.("shift")',
    'process.platform !== "win32"',
    "metadata.mode & 0o111",
    "spawnSync(path, [], {",
    "env: {},",
    'result.stderr !== ""',
    "expectedKeys",
    "randomBytes(",
    'operation: "set"',
    'operation: "get"',
    'operation: "delete"',
    "replacementSecret",
    "rigyn-keychain-helper: request failed",
  ]) assert.ok(verify.includes(fragment), `native verification must contain ${fragment}`);
});
