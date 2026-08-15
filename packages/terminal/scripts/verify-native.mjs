import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import targets from "../native/targets.json" with { type: "json" };

const KEYCHAIN_MESSAGE_LIMIT = 1_048_576;

function keychainRequest(path, request) {
  const input = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  try {
    const result = spawnSync(path, [], {
      input,
      encoding: "utf8",
      env: {},
      timeout: 5_000,
      maxBuffer: KEYCHAIN_MESSAGE_LIMIT,
    });
    if (result.error || result.status !== 0 || result.signal !== null || result.stderr !== "") {
      throw new Error("keychain helper probe failed");
    }
    if (!result.stdout.endsWith("\n")) throw new Error("keychain helper probe returned an invalid response");
    const line = result.stdout.slice(0, -1);
    if (line.includes("\n") || line.includes("\r")) {
      throw new Error("keychain helper probe returned an invalid response");
    }
    try {
      return JSON.parse(line);
    } catch {
      throw new Error("keychain helper probe returned an invalid response");
    }
  } finally {
    input.fill(0);
  }
}

function requireKeychainResponse(response, status, secret) {
  const expectedKeys = secret === undefined ? ["status", "version"] : ["secret", "status", "version"];
  if (
    response === null
    || typeof response !== "object"
    || Array.isArray(response)
    || Object.keys(response).sort().join("\0") !== expectedKeys.join("\0")
    || response.version !== 1
    || response.status !== status
    || (secret !== undefined && response.secret !== secret)
  ) throw new Error("keychain helper probe returned an invalid response");
}

const expected = new Set(["darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"]);
if (targets.schemaVersion !== 1 || !Array.isArray(targets.targets)) throw new Error("invalid native target manifest");
if (targets.targets.length !== expected.size) throw new Error("native target manifest must contain four release targets");

for (const target of targets.targets) {
  const key = `${target.platform}-${target.arch}`;
  if (!expected.delete(key)) throw new Error(`unexpected or duplicate native target: ${key}`);
  const source = await readFile(target.source, "utf8");
  if (!source.includes("napi_register_module_v1")) throw new Error(`native source does not declare an N-API entry point: ${target.source}`);
  if (target.platform === "darwin") {
    if (target.keychain?.source !== "native/darwin/src/rigyn-keychain-helper.swift"
      || target.keychain.output !== `native/darwin/prebuilds/darwin-${target.arch}/rigyn-keychain-helper`) {
      throw new Error(`Darwin target does not declare the fixed keychain helper: ${key}`);
    }
    const keychainSource = await readFile(target.keychain.source, "utf8");
    for (const fragment of ["import Security", "FileHandle.standardInput", "SecItemCopyMatching", "SecItemAdd", "SecItemUpdate", "SecItemDelete"]) {
      if (!keychainSource.includes(fragment)) throw new Error(`keychain helper source is missing ${fragment}`);
    }
  } else if (target.keychain !== undefined) {
    throw new Error(`non-Darwin target declares a keychain helper: ${key}`);
  }
}
if (expected.size > 0) throw new Error(`native targets are missing: ${[...expected].join(", ")}`);

const release = process.argv.includes("--release");
const local = targets.targets.find((target) => target.platform === process.platform && target.arch === process.arch);
const selected = release ? targets.targets : local ? [local] : [];
for (const target of selected) {
  for (const output of [target.output, ...(target.keychain ? [target.keychain.output] : [])]) {
    let metadata;
    try {
      metadata = await stat(output);
    } catch {
      throw new Error(`required native artifact is missing: ${output}`);
    }
    if (!metadata.isFile() || metadata.size < 512) throw new Error(`native artifact is invalid: ${output}`);
    if (process.platform !== "win32" && output === target.keychain?.output && (metadata.mode & 0o111) === 0) {
      throw new Error(`keychain helper is not executable: ${output}`);
    }
    const header = await readFile(output);
    const executable = target.platform === "win32"
      ? header[0] === 0x4d && header[1] === 0x5a
      : [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(header.readUInt32BE(0));
    if (!executable) throw new Error(`native artifact has an unexpected executable header: ${output}`);
  }
}

if (local) {
  const require = createRequire(import.meta.url);
  const helper = require(fileURLToPath(new URL(`../${local.output}`, import.meta.url)));
  const value = process.platform === "darwin" ? helper.modifierPressed?.("shift") : helper.enableVirtualTerminalInput?.();
  if (typeof value !== "boolean") throw new Error(`native helper did not return a boolean: ${local.output}`);
  if (local.keychain) {
    const executable = fileURLToPath(new URL(`../${local.keychain.output}`, import.meta.url));
    const rejected = spawnSync(
      executable,
      [],
      {
        input: '{"version":0}\n',
        encoding: "utf8",
        env: {},
        timeout: 5_000,
        maxBuffer: KEYCHAIN_MESSAGE_LIMIT,
      },
    );
    if (rejected.error) throw rejected.error;
    if (rejected.status !== 1 || rejected.stdout !== "" || rejected.stderr !== "rigyn-keychain-helper: request failed\n") {
      throw new Error(`keychain helper did not enforce its stdin protocol: ${local.keychain.output}`);
    }

    const nonce = `${process.pid}-${randomBytes(16).toString("hex")}`;
    const service = `rigyn-native-verification-${nonce}`;
    const account = `probe-${nonce}`;
    const secret = randomBytes(32).toString("base64url");
    const replacementSecret = randomBytes(32).toString("base64url");
    const common = { version: 1, service, account };
    try {
      requireKeychainResponse(keychainRequest(executable, { ...common, operation: "get" }), "not_found");
      requireKeychainResponse(keychainRequest(executable, { ...common, operation: "set", secret }), "ok");
      requireKeychainResponse(keychainRequest(executable, { ...common, operation: "get" }), "ok", secret);
      requireKeychainResponse(
        keychainRequest(executable, { ...common, operation: "set", secret: replacementSecret }),
        "ok",
      );
      requireKeychainResponse(
        keychainRequest(executable, { ...common, operation: "get" }),
        "ok",
        replacementSecret,
      );
      requireKeychainResponse(keychainRequest(executable, { ...common, operation: "delete" }), "ok");
      requireKeychainResponse(keychainRequest(executable, { ...common, operation: "get" }), "not_found");
    } finally {
      const cleanup = keychainRequest(executable, { ...common, operation: "delete" });
      if (cleanup?.status !== "ok" && cleanup?.status !== "not_found") {
        throw new Error("keychain helper probe cleanup failed");
      }
      requireKeychainResponse(cleanup, cleanup.status);
    }
  }
  console.log(`native source, layout, and runtime verified for ${process.platform}-${process.arch}`);
} else {
  console.log(`native source and four-target release layout verified; runtime loading requires a macOS or Windows host (current: ${process.platform}-${process.arch})`);
}

if (release) console.log("all native release artifacts verified");
