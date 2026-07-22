import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  createStandaloneInstallPlan,
  parseStandaloneArguments,
} from "../../../../scripts/build-standalone.mjs";
import { finalizeRelease } from "../../../../scripts/finalize-release.mjs";
import { createStandaloneArchive, createTarHeader } from "../../../../scripts/standalone-archive.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");

test("standalone argument parsing requires explicit staging and output directories", () => {
  assert.throws(() => parseStandaloneArguments([]), /--directory is required/u);
  assert.throws(
    () => parseStandaloneArguments(["--directory", ".release", "--output", ".standalone", "--output", "again"]),
    /--output may be specified only once/u,
  );
  const parsed = parseStandaloneArguments([
    "--directory", ".release", "--output", ".standalone", "--runtime-root", ".runtime",
  ]);
  assert.deepEqual(parsed, {
    directory: resolve(REPOSITORY_ROOT, ".release"),
    output: resolve(REPOSITORY_ROOT, ".standalone"),
    runtimeRoot: resolve(REPOSITORY_ROOT, ".runtime"),
  });
});

test("standalone dependency installation may fill a fresh cache without inheriting credentials", () => {
  const archives = [resolve("release", "rigyn-terminal.tgz"), resolve("release", "rigyn.tgz")];
  const plan = createStandaloneInstallPlan(resolve("isolated"), archives);
  assert.equal(plan.environment.npm_config_offline, "false");
  assert.equal(plan.environment.npm_config_prefer_offline, "true");
  assert.equal(plan.args.includes("--offline"), false);
  assert.equal(plan.args.includes("--offline=false"), true);
  assert.equal(plan.args.includes("--prefer-offline"), true);
  assert.deepEqual(plan.args.slice(-archives.length), archives);
  assert.equal(Object.keys(plan.environment).some((name) => /(?:token|secret|password)/iu.test(name)), false);
});

test("standalone tar headers normalize owner, timestamp, and executable mode", () => {
  const header = createTarHeader({ path: "rigyn/bin/rigyn", bytes: 7, mode: 0o755, type: "0" });
  assert.equal(header.subarray(100, 108).toString("ascii"), "0000755\0");
  assert.equal(header.subarray(108, 116).toString("ascii"), "0000000\0");
  assert.equal(header.subarray(116, 124).toString("ascii"), "0000000\0");
  assert.equal(header.subarray(136, 148).toString("ascii"), "00000000000\0");
  assert.equal(header.subarray(265, 269).toString("ascii"), "root");
});

test("standalone archive bytes are deterministic for identical content", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-standalone-archive-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const source = resolve(root, "payload");
  await mkdir(resolve(source, "bin"), { recursive: true });
  await writeFile(resolve(source, "BUILD-METADATA.json"), "{\n  \"schemaVersion\": 1\n}\n");
  await writeFile(resolve(source, "bin/rigyn"), "#!/bin/sh\n", { mode: 0o755 });
  const longName = `${"dependency-generated-name-".repeat(5)}.js`;
  await writeFile(resolve(source, longName), "export {};\n");
  const first = resolve(root, "first.tar.gz");
  const second = resolve(root, "second.tar.gz");
  await createStandaloneArchive(source, first, "rigyn-v0.0.0-linux-x64");
  await createStandaloneArchive(source, second, "rigyn-v0.0.0-linux-x64");
  assert.deepEqual(await readFile(first), await readFile(second));
  const tar = gunzipSync(await readFile(first));
  assert.equal(tar.length % 512, 0);
  assert.equal(tar.includes(Buffer.from(`path=rigyn-v0.0.0-linux-x64/${longName}\n`)), true);
  assert.equal(tar.subarray(-1024).every((byte) => byte === 0), true);
});

test("release finalization records every target archive in policy order", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-release-finalize-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const directory = resolve(root, "release");
  const standaloneDirectory = resolve(root, "standalone");
  await Promise.all([mkdir(directory), mkdir(standaloneDirectory)]);
  const policy = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, "packages/rigyn/release/platforms.json"), "utf8"));
  const npmContents = Buffer.from("npm archive fixture\n");
  const npmArchive = {
    name: "rigyn",
    version: "0.4.0",
    file: "rigyn-0.4.0.tgz",
    sha256: createHash("sha256").update(npmContents).digest("hex"),
    integrity: "sha512-fixture",
    bytes: npmContents.length,
  };
  const sourceContents = Buffer.from("source archive fixture\n");
  const source = {
    schemaVersion: 1,
    file: "rigyn-v0.4.0-source.tar.gz",
    root: "rigyn-v0.4.0",
    commit: "1".repeat(40),
    sha256: createHash("sha256").update(sourceContents).digest("hex"),
    bytes: sourceContents.length,
  };
  await writeFile(resolve(directory, npmArchive.file), npmContents);
  await writeFile(resolve(directory, source.file), sourceContents);
  await writeFile(resolve(directory, "release-manifest.json"), `${JSON.stringify({
    schemaVersion: 4,
    product: "rigyn",
    version: "0.4.0",
    nodeRuntime: policy.nodeRuntime.version,
    archives: [npmArchive],
    source,
    standalones: [],
    targets: policy.targets,
    checksumFile: "SHA256SUMS",
  }, null, 2)}\n`);
  for (const target of policy.targets) {
    const file = `rigyn-v0.4.0-${target.platform}-${target.arch}.tar.gz`;
    const contents = Buffer.from(`${target.platform}/${target.arch}\n`);
    await writeFile(resolve(standaloneDirectory, file), contents);
    await writeFile(resolve(standaloneDirectory, `${file}.json`), `${JSON.stringify({
      schemaVersion: 1,
      product: "rigyn",
      version: "0.4.0",
      platform: target.platform,
      arch: target.arch,
      node: policy.nodeRuntime.version,
      entrypoint: target.platform === "win32" ? "bin/rigyn.cmd" : "bin/rigyn",
      file,
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.length,
    }, null, 2)}\n`);
  }

  await finalizeRelease({ directory, standaloneDirectory });
  const finalized = JSON.parse(await readFile(resolve(directory, "release-manifest.json"), "utf8"));
  assert.deepEqual(
    finalized.standalones.map(({ platform, arch }) => ({ platform, arch })),
    policy.targets.map(({ platform, arch }) => ({ platform, arch })),
  );
  const checksums = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
  assert.deepEqual(
    checksums.trimEnd().split("\n").map((line) => line.slice(66)),
    [npmArchive.file, source.file, ...finalized.standalones.map(({ file }) => file)],
  );
  const marker = JSON.parse(await readFile(resolve(directory, ".rigyn-release-output.json"), "utf8"));
  assert.equal(marker.archives.length, 2 + policy.targets.length);
});
