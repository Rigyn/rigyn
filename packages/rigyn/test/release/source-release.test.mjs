import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { runBoundedCommand } from "../../../../scripts/bounded-command.mjs";
import {
  REQUIRED_SOURCE_PATHS,
  createSourceArchive,
  inspectSourceArchive,
} from "../../../../scripts/source-archive.mjs";
import { verifySourceRelease } from "../../../../scripts/verify-source-archive.mjs";

const FIXTURE_REQUIRED_PATHS = [
  "package.json",
  "package-lock.json",
  "scripts/build.mjs",
  "src/index.js",
];

function tarArchive(path, type = "0") {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write("00000000000\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return gzipSync(Buffer.concat([header, Buffer.alloc(1_024)]));
}

async function git(root, args) {
  return await runBoundedCommand("git", args, {
    cwd: root,
    env: process.env,
    timeoutMs: 30_000,
    label: `git ${args[0]}`,
  });
}

async function createFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "rigyn-source-release-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  await Promise.all([
    mkdir(resolve(root, "scripts"), { recursive: true }),
    mkdir(resolve(root, "src"), { recursive: true }),
    mkdir(resolve(root, "node_modules/dependency"), { recursive: true }),
    mkdir(resolve(root, "dist"), { recursive: true }),
    mkdir(resolve(root, "packages/terminal/native/darwin/prebuilds/darwin-x64"), { recursive: true }),
  ]);
  const manifest = {
    name: "source-fixture",
    version: "1.2.3",
    private: true,
    scripts: { build: "node scripts/build.mjs" },
  };
  await Promise.all([
    writeFile(resolve(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(resolve(root, "package-lock.json"), `${JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": manifest },
    }, null, 2)}\n`),
    writeFile(resolve(root, "scripts/build.mjs"), 'process.stdout.write("fixture source build passed\\n");\n'),
    writeFile(resolve(root, "src/index.js"), "export const source = 'committed';\n"),
    writeFile(resolve(root, "node_modules/dependency/leak.js"), "dependency leak\n"),
    writeFile(resolve(root, "dist/generated.js"), "build leak\n"),
    writeFile(resolve(root, "packages/terminal/native/darwin/prebuilds/darwin-x64/helper.node"), "native leak\n"),
  ]);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "release-test@example.invalid"]);
  await git(root, ["config", "user.name", "Release Test"]);
  await git(root, ["add", "-f", "."]);
  await git(root, ["commit", "-m", "fixture release"]);
  await git(root, ["tag", "v1.2.3"]);
  const commit = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, commit };
}

test("source archive policy requires the build and private-install inputs", () => {
  for (const path of [
    "package.json",
    "package-lock.json",
    "scripts/generate-provider-models.mjs",
    "packages/rigyn/src/providers/maintained-model-catalog.ts",
    "packages/terminal/scripts/build-native.mjs",
    "packages/terminal/native/darwin/src/darwin-modifiers.c",
    "packages/terminal/native/win32/src/win32-console-mode.c",
    "packages/rigyn/scripts/install-user.mjs",
  ]) assert.ok(REQUIRED_SOURCE_PATHS.includes(path), `source policy is missing ${path}`);
});

test("source archives are deterministic, commit-exact, rooted, and exclude generated payloads", async (context) => {
  const fixture = await createFixture(context);
  await git(fixture.root, ["config", "core.autocrlf", "true"]);
  await writeFile(resolve(fixture.root, "src/index.js"), "export const source = 'dirty working tree';\n");
  await writeFile(resolve(fixture.root, "untracked-secret.txt"), "must not be archived\n");
  const firstDirectory = resolve(fixture.root, "release-one");
  const secondDirectory = resolve(fixture.root, "release-two");
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
  const filename = "rigyn-v1.2.3-source.tar.gz";
  const firstPath = resolve(firstDirectory, filename);
  const secondPath = resolve(secondDirectory, filename);

  const first = await createSourceArchive({
    repositoryRoot: fixture.root,
    version: "1.2.3",
    ref: "v1.2.3",
    output: firstPath,
    requiredPaths: FIXTURE_REQUIRED_PATHS,
  });
  const second = await createSourceArchive({
    repositoryRoot: fixture.root,
    version: "1.2.3",
    ref: fixture.commit,
    output: secondPath,
    requiredPaths: FIXTURE_REQUIRED_PATHS,
  });

  assert.deepEqual(await readFile(firstPath), await readFile(secondPath));
  assert.equal(first.commit, fixture.commit);
  assert.equal(first.root, "rigyn-v1.2.3");
  assert.equal(first.sha256, second.sha256);
  const inspected = await inspectSourceArchive(firstPath, {
    root: first.root,
    requiredPaths: FIXTURE_REQUIRED_PATHS,
  });
  assert.ok(inspected.entries.includes("rigyn-v1.2.3/src/index.js"));
  assert.equal(inspected.files.get("rigyn-v1.2.3/src/index.js")?.toString("utf8"),
    "export const source = 'committed';\n");
  for (const fragment of ["node_modules", "/dist/", "/prebuilds/", "untracked-secret"]) {
    assert.equal(inspected.entries.some((entry) => entry.includes(fragment)), false, `archive leaked ${fragment}`);
  }
});

test("source archive creation rejects a mismatched version or incomplete build tree", async (context) => {
  const fixture = await createFixture(context);
  await assert.rejects(
    createSourceArchive({
      repositoryRoot: fixture.root,
      version: "9.9.9",
      ref: "HEAD",
      output: resolve(fixture.root, "wrong.tar.gz"),
      requiredPaths: FIXTURE_REQUIRED_PATHS,
    }),
    /does not match package version/u,
  );
  await assert.rejects(
    createSourceArchive({
      repositoryRoot: fixture.root,
      version: "1.2.3",
      ref: "HEAD",
      output: resolve(fixture.root, "missing.tar.gz"),
      requiredPaths: [...FIXTURE_REQUIRED_PATHS, "scripts/missing.mjs"],
    }),
    /missing required path: scripts\/missing\.mjs/u,
  );
});

test("source archive inspection rejects traversal and link entries before extraction", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-source-unsafe-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const traversal = resolve(root, "traversal.tar.gz");
  const link = resolve(root, "link.tar.gz");
  await Promise.all([
    writeFile(traversal, tarArchive("rigyn-v1.0.0/../escape")),
    writeFile(link, tarArchive("rigyn-v1.0.0/link", "2")),
  ]);

  await assert.rejects(
    inspectSourceArchive(traversal, { root: "rigyn-v1.0.0", requiredPaths: [] }),
    /unsafe path/u,
  );
  await assert.rejects(
    inspectSourceArchive(link, { root: "rigyn-v1.0.0", requiredPaths: [] }),
    /unsupported tar entry type/u,
  );
});

test("a staged source artifact extracts and builds without checkout dependencies", async (context) => {
  const fixture = await createFixture(context);
  const directory = resolve(fixture.root, "release");
  await mkdir(directory);
  const output = resolve(directory, "rigyn-v1.2.3-source.tar.gz");
  const source = await createSourceArchive({
    repositoryRoot: fixture.root,
    version: "1.2.3",
    ref: fixture.commit,
    output,
    requiredPaths: FIXTURE_REQUIRED_PATHS,
  });
  await writeFile(resolve(directory, "release-manifest.json"), `${JSON.stringify({
    schemaVersion: 4,
    product: "rigyn",
    version: "1.2.3",
    source,
  }, null, 2)}\n`);

  const verified = await verifySourceRelease({
    directory,
    build: true,
    requiredPaths: FIXTURE_REQUIRED_PATHS,
  });
  assert.match(verified.build.stdout, /fixture source build passed/u);
  assert.equal(verified.source.commit, fixture.commit);
});
