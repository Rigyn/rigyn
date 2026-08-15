import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  createOfflineReleaseEnvironment,
  OFFLINE_RELEASE_FOCUSED_CHECKS,
} from "../../benchmarks/offline-release.js";

const execute = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("offline release evaluation fills only the seams outside the composed release guards", () => {
  assert.deepEqual(OFFLINE_RELEASE_FOCUSED_CHECKS.map((check) => ({
    id: check.id,
    areas: check.areas,
  })), [
    { id: "tui-lifecycle", areas: ["tui-lifecycle"] },
    { id: "tool-coordinator", areas: ["tool-coordinator"] },
    { id: "context-and-cache", areas: ["compaction-cache"] },
    { id: "v4-recovery", areas: ["v4-recovery"] },
    { id: "portable-plugins", areas: ["portable-plugins"] },
    { id: "observability", areas: ["observability"] },
    { id: "provider-auth-contracts", areas: ["provider-auth-contracts"] },
  ]);
  const files = OFFLINE_RELEASE_FOCUSED_CHECKS.flatMap((check) => check.testFiles);
  assert.equal(files.some((file) => file.includes("/live/")), false);
  assert.equal(files.some((file) => file.includes("provider-factory") || file.includes("remote-catalog")), false);
  assert.ok(files.includes("../kernel/test/semantic/session-v4-io-hardening.test.ts"));
  assert.ok(files.includes("test/service/agent-session-process-death-recovery.test.ts"));
  assert.ok(files.includes("test/cli/refresh-pty.test.ts"));
  assert.ok(files.includes("test/tools/coordinator-scheduling.test.ts"));
  assert.ok(files.includes("test/core/cache-diagnostics.test.ts"));
  assert.ok(files.includes("test/core/portable-plugin.test.ts"));
  assert.ok(files.includes("test/embedding/observability.test.ts"));
  assert.ok(files.includes("../models/test/auth-boundaries.test.ts"));
  assert.ok(files.includes("../models/test/protocol-transports.test.ts"));
  assert.ok(files.includes("test/providers/builtin-provider-wire-contract.test.ts"));
});

test("offline release focused checks reference existing test files", async () => {
  await Promise.all(OFFLINE_RELEASE_FOCUSED_CHECKS.flatMap((check) =>
    check.testFiles.map(async (file) => await access(resolve(PACKAGE_ROOT, file)))));
});

test("offline release environment keeps process essentials but cannot inherit credentials or user state", () => {
  const isolatedRoot = resolve("/isolated");
  const environment = createOfflineReleaseEnvironment({
    PATH: "/fixture/bin",
    CI: "true",
    HOME: "/private/home",
    NODE_OPTIONS: "--allow-net",
    OPENAI_API_KEY: "private-openai-key",
    AWS_PROFILE: "private-profile",
    AWS_SHARED_CREDENTIALS_FILE: "/private/aws-credentials",
    AZURE_CONFIG_DIR: "/private/azure",
    CLOUDSDK_CONFIG: "/private/google-cloud",
    GOOGLE_APPLICATION_CREDENTIALS: "/private/google.json",
    NPM_TOKEN: "private-registry-token",
  }, isolatedRoot, "file:///network-guard.mjs");

  assert.equal(environment.PATH, "/fixture/bin");
  assert.equal(environment.CI, "true");
  assert.equal(environment.HOME, join(isolatedRoot, "home"));
  assert.equal(environment.RIGYN_HOME, join(isolatedRoot, "home", ".rigyn"));
  assert.equal(environment.NODE_OPTIONS, "--import=file:///network-guard.mjs");
  assert.equal(environment.AWS_EC2_METADATA_DISABLED, "true");
  assert.equal(Object.hasOwn(environment, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(environment, "AWS_PROFILE"), false);
  assert.equal(Object.hasOwn(environment, "AWS_SHARED_CREDENTIALS_FILE"), false);
  assert.equal(Object.hasOwn(environment, "AZURE_CONFIG_DIR"), false);
  assert.equal(Object.hasOwn(environment, "CLOUDSDK_CONFIG"), false);
  assert.equal(Object.hasOwn(environment, "GOOGLE_APPLICATION_CREDENTIALS"), false);
  assert.equal(Object.hasOwn(environment, "NPM_TOKEN"), false);
});

test("offline release network guard rejects external fetch before transport", async () => {
  const guard = pathToFileURL(fileURLToPath(
    new URL("../../benchmarks/offline-network-guard.mjs", import.meta.url),
  )).href;
  assert.equal(new URL(guard).protocol, "file:");
  const result = await execute(process.execPath, [
    "--import",
    guard,
    "--input-type=module",
    "--eval",
    [
      "import { Socket } from 'node:net';",
      "const failures = [];",
      "await fetch('https://offline-release.invalid').catch((error) => failures.push(error.message));",
      "try { new Socket().connect({ host: 'offline-release.invalid', port: 443 }); }",
      "catch (error) { failures.push(error.message); }",
      "process.stdout.write(JSON.stringify(failures));",
    ].join("\n"),
  ]);
  const failures = JSON.parse(result.stdout) as string[];
  assert.equal(failures.length, 2);
  assert.ok(failures.every((failure) =>
    failure.includes("External network access is disabled in the offline release evaluation")));
});

test("offline release report schema is closed, versioned, and names all seven areas", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../benchmarks/offline-release-report.schema.json", import.meta.url),
    "utf8",
  )) as {
    $id?: string;
    additionalProperties?: boolean;
    properties?: { schemaVersion?: { const?: number } };
    $defs?: { areaId?: { enum?: string[] } };
  };
  assert.equal(
    schema.$id,
    "https://github.com/rigyn/rigyn/blob/main/packages/rigyn/benchmarks/offline-release-report.schema.json",
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.schemaVersion?.const, 1);
  assert.deepEqual(schema.$defs?.areaId?.enum, [
    "tui-lifecycle",
    "tool-coordinator",
    "compaction-cache",
    "v4-recovery",
    "portable-plugins",
    "observability",
    "provider-auth-contracts",
  ]);
});
