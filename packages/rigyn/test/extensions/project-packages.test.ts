import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import type { ResolvedPaths } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getExtensionRuntimeHost } from "../../src/extensions/compat.js";
import {
  PROJECT_PACKAGE_DECLARATION,
  PROJECT_PACKAGE_INSTALL_ROOT,
  PROJECT_PACKAGE_LOCK,
  ProjectPackageManager,
  type InstalledProjectPackage,
  type ProjectPackageCatalogEntry,
  mergeProjectPackageResourceFilters,
  parseProjectPackageDeclaration,
  parseProjectPackageLock,
  projectPackageDirectMetadata,
  projectPackageDeclarationSha256,
  projectPackagePlatformFingerprint,
} from "../../src/extensions/project-packages.js";

interface Fixture {
  workspace: string;
  source: string;
  leaseRoot: string;
}

const execFile = promisify(execFileCallback);

async function fixture(context: TestContext): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-project-packages-"));
  const source = join(workspace, "package-source");
  const leaseRoot = join(workspace, "private-leases");
  await mkdir(join(workspace, ".rigyn"));
  await mkdir(join(source, "extensions"), { recursive: true });
  context.after(async () => {
    await rm(workspace, { recursive: true, force: true });
  });
  return { workspace, source, leaseRoot };
}

async function writePackage(value: Fixture, version: string, factory = "export default () => {};\n"): Promise<void> {
  await writeFile(join(value.source, "package.json"), `${JSON.stringify({
    name: "declared-package",
    version,
    type: "module",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }, null, 2)}\n`);
  await writeFile(join(value.source, "extensions", "index.mjs"), factory);
}

async function writeDeclaration(value: Fixture, disabledResources: string[] = []): Promise<void> {
  await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), `${JSON.stringify({
    schemaVersion: 1,
    packages: [{
      id: "declared",
      source: { kind: "local", path: "package-source" },
      disabledResources,
    }],
  }, null, 2)}\n`);
}

function manager(value: Fixture, trusted = true): ProjectPackageManager {
  return new ProjectPackageManager({
    workspace: value.workspace,
    projectTrusted: trusted,
    operationLeaseRoot: value.leaseRoot,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const input = value as Record<string, unknown>;
  return `{${Object.keys(input).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
}

async function legacyContentSha256(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (relativeDirectory === "" && [".rigyn-package.json", ".rigyn-packages.lock", "node_modules"].includes(name)) continue;
      const path = join(directory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const information = await lstat(path);
      if (information.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      const data = await readFile(path);
      hash.update(Buffer.from(`${Buffer.byteLength(relativePath)}:`));
      hash.update(relativePath);
      hash.update(Buffer.from(`:${data.byteLength}:`));
      hash.update(data);
    }
  };
  await visit(root);
  return hash.digest("hex");
}

test("public v1 declaration parsing preserves legacy grammar while locks remain deterministic", () => {
  assert.equal(projectPackagePlatformFingerprint({
    platform: "linux",
    architecture: "x64",
    nodeAbi: "127",
    glibcVersionRuntime: "2.39",
  }), "linux/x64/glibc/node-abi-127");
  assert.equal(projectPackagePlatformFingerprint({
    platform: "linux",
    architecture: "x64",
    nodeAbi: "127",
  }), "linux/x64/musl/node-abi-127");
  assert.equal(projectPackagePlatformFingerprint({
    platform: "darwin",
    architecture: "arm64",
    nodeAbi: "127",
    glibcVersionRuntime: "ignored",
  }), "darwin/arm64/libc-na/node-abi-127");

  const declaration = parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [
      { id: "z-git", source: { kind: "git", repository: "https://example.com/team/tools.git", ref: "main" } },
      { id: "a-npm", source: { kind: "npm", package: "@example/tools", selector: "^1.2.0" }, disabledResources: ["command:review", "command:review"] },
      { id: "m-local", source: { kind: "local", path: "packages/local" } },
    ],
  });
  assert.deepEqual(declaration.packages.map((entry) => entry.id), ["a-npm", "m-local", "z-git"]);
  assert.deepEqual(declaration.packages[0]?.disabledResources, ["command:review"]);
  assert.throws(() => parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "unsafe", source: { kind: "local", path: "../outside" } }],
  }), /workspace-relative/u);
  assert.throws(() => parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "unsafe", source: { kind: "local", path: "C:extensions/pkg" } }],
  }), /workspace-relative/u);
  assert.throws(() => parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "unsafe", source: { kind: "git", repository: "https://secret@example.com/team/tools.git" } }],
  }), /credential-free/u);
  for (const selector of ["latest", "next", "1.2.3", "^1.2.0", "~1.2.0", "*"]) {
    assert.doesNotThrow(() => parseProjectPackageDeclaration({
      schemaVersion: 1,
      packages: [{ id: "registry", source: { kind: "npm", package: "registry-package", selector } }],
    }));
  }
  for (const selector of ["npm:alias", "../outside", "/absolute", "github:team/repository", "workspace:*", "link:../package"]) {
    assert.throws(() => parseProjectPackageDeclaration({
      schemaVersion: 1,
      packages: [{ id: "registry", source: { kind: "npm", package: "registry-package", selector } }],
    }), /semver range|dist-tag/u);
  }
  for (const repository of [
    "http://example.com/team/tools.git",
    "git://example.com/team/tools.git",
    "ftp://example.com/team/tools.git",
  ]) {
    assert.throws(() => parseProjectPackageDeclaration({
      schemaVersion: 1,
      packages: [{ id: "repository", source: { kind: "git", repository } }],
    }), /HTTPS or SSH/u);
  }
  for (const ref of ["--upload-pack=bad", "feature branch", "../main", "refs/heads/main.lock", "topic..main"]) {
    assert.throws(() => parseProjectPackageDeclaration({
      schemaVersion: 1,
      packages: [{ id: "repository", source: { kind: "git", repository: "https://example.com/team/tools.git", ref } }],
    }), /safe Git ref/u);
  }
  for (const disabled of ["prompt:/absolute.md", "skill:../outside", "theme:a/../b.json"]) {
    assert.doesNotThrow(() => parseProjectPackageDeclaration({
      schemaVersion: 1,
      packages: [{ id: "local", source: { kind: "local", path: "package" }, disabledResources: [disabled] }],
    }));
  }
  const historical = parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{
      id: "legacy",
      source: { kind: "git", repository: "ssh://alice@example.com/team/tools.git", ref: "main" },
      disabledResources: ["runtime:./runtime/index.mjs"],
    }],
  });
  assert.equal(historical.packages[0]?.source.kind === "git" ? historical.packages[0].source.repository : undefined,
    "ssh://alice@example.com/team/tools.git");
  assert.deepEqual(historical.packages[0]?.disabledResources, ["runtime:./runtime/index.mjs"]);
  assert.deepEqual(parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{
      id: "local",
      source: { kind: "local", path: "package" },
      disabledResources: ["prompt:!keep.md", "prompt:#literal.md"],
    }],
  }).packages[0]?.disabledResources, ["prompt:!keep.md", "prompt:#literal.md"]);

  const lockedDeclaration = parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "local", source: { kind: "local", path: "package" } }],
  });
  const hash = "a".repeat(64);
  assert.throws(() => parseProjectPackageLock({
    schemaVersion: 1,
    declarationSha256: projectPackageDeclarationSha256(lockedDeclaration),
    packages: [{
      id: "local",
      declaration: lockedDeclaration.packages[0],
      resolved: { kind: "local", path: "C:extensions/pkg", manifestSha256: hash, contentSha256: hash },
    }],
  }), /workspace-relative/u);
  const lock = parseProjectPackageLock({
    schemaVersion: 1,
    declarationSha256: projectPackageDeclarationSha256(lockedDeclaration),
    packages: [{
      id: "local",
      declaration: lockedDeclaration.packages[0],
      resolved: { kind: "local", path: "package", manifestSha256: hash, contentSha256: hash },
    }],
  });
  assert.equal(lock.packages[0]?.id, "local");
  assert.throws(() => parseProjectPackageLock({ ...lock, declarationSha256: "b".repeat(64) }), /digest/u);
  const nonPortable = {
    schemaVersion: 1 as const,
    packages: [{ id: "con", source: { kind: "local" as const, path: "package" }, disabledResources: [] }],
  };
  const mappedLock = parseProjectPackageLock({
    schemaVersion: 2,
    declarationSha256: projectPackageDeclarationSha256(nonPortable),
    packages: [{
      id: "con",
      declaration: nonPortable.packages[0],
      resolved: { kind: "local", path: "package", manifestSha256: hash, contentSha256: hash },
    }],
  });
  assert.equal(mappedLock.packages[0]?.id, "con");
});

test("project package filter records and derived runtime identities are collision-safe", () => {
  assert.deepEqual(mergeProjectPackageResourceFilters({}, { constructor: ["prompt:review"] }), {
    constructor: ["prompt:review"],
  });

  const hash = "a".repeat(64);
  const longId = `a${"b".repeat(62)}`;
  const roots = new Map([
    [longId, "/packages/long"],
    ["foo", "/packages/foo"],
    ["foo-2", "/packages/foo-2"],
  ]);
  const packages: InstalledProjectPackage[] = [...roots].map(([id, packageRoot]) => ({
    id,
    name: id,
    scope: "project",
    packageRoot,
    manifestPath: join(packageRoot, "package.json"),
    manifestModified: false,
    provenance: {
      schemaVersion: 1,
      id,
      scope: "project",
      installedAt: "2026-01-01T00:00:00.000Z",
      manifestSha256: hash,
      kind: "local",
      sourcePath: packageRoot,
    },
  }));
  const catalog: ProjectPackageCatalogEntry[] = [...roots].map(([id]) => ({
    id,
    source: { kind: "local", path: id },
    disabledResources: [],
    resolved: { kind: "local", path: id, manifestSha256: hash, contentSha256: hash },
  }));
  const extension = (id: string, name: string): ResolvedPaths["extensions"][number] => ({
    path: join(roots.get(id)!, name),
    enabled: true,
    metadata: { source: roots.get(id)!, scope: "project", origin: "package", baseDir: roots.get(id)! },
  });
  const resources: ResolvedPaths = {
    extensions: [
      extension(longId, "one.mjs"),
      extension(longId, "two.mjs"),
      extension("foo", "one.mjs"),
      extension("foo", "two.mjs"),
      extension("foo-2", "one.mjs"),
    ],
    skills: [],
    prompts: [],
    themes: [],
  };
  const metadata = projectPackageDirectMetadata(resources, packages, catalog);
  const ids = resources.extensions.map((entry) => metadata.get(entry.path)?.extensionId);
  assert.notEqual(ids[0], longId);
  assert.ok(ids[0] !== undefined && ids[0].length <= 63);
  assert.ok(ids[1] !== undefined && ids[1].length <= 63);
  assert.notEqual(ids[2], "foo");
  assert.notEqual(ids[3], "foo-2");
  assert.equal(ids[4], "foo-2");
  assert.equal(new Set(ids).size, ids.length);
});

test("untrusted project declarations are ignored without reading project files", async (context) => {
  const value = await fixture(context);
  await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), "not valid JSON");
  assert.deepEqual(await manager(value, false).check(), {
    status: "ignored",
    trusted: false,
    packageCount: 0,
    packages: [],
    message: "Project package declarations are ignored until the workspace is trusted.",
  });
  assert.deepEqual(await manager(value, false).reconcile(), {
    status: "ignored",
    changed: false,
    packages: [],
    catalog: [],
  });
});

test("dependency lock snapshots are canonical, portable, and credential-free", () => {
  const declaration = parseProjectPackageDeclaration({
    schemaVersion: 1,
    packages: [{ id: "local", source: { kind: "local", path: "package" } }],
  });
  const hash = "a".repeat(64);
  const parseWith = (lockValue: Record<string, unknown>) => {
    const content = `${canonicalJson(lockValue)}\n`;
    return parseProjectPackageLock({
      schemaVersion: 2,
      declarationSha256: projectPackageDeclarationSha256(declaration),
      packages: [{
        id: "local",
        declaration: declaration.packages[0],
        resolved: {
          kind: "local",
          path: "package",
          manifestSha256: hash,
          contentSha256: hash,
          dependencyLock: {
            sha256: createHash("sha256").update(content).digest("hex"),
            content,
          },
          dependencyContentSha256: hash,
        },
      }],
    });
  };
  const ordinary = {
    lockfileVersion: 3,
    packages: {
      "": { name: "package", version: "1.0.0" },
      "node_modules/jsonwebtoken": {
        version: "9.0.2",
        resolved: "https://registry.example/jsonwebtoken.tgz",
        integrity: "sha512-safe",
      },
    },
  };
  assert.doesNotThrow(() => parseWith(ordinary));
  assert.equal(canonicalJson({ z: 1, A: 1, _: 1, a: 1 }), "{\"A\":1,\"_\":1,\"a\":1,\"z\":1}");
  for (const unsafe of [
    { ...ordinary, _authToken: "secret-value" },
    { ...ordinary, "//registry.example/:_password": "secret-value" },
    { ...ordinary, "https://user:secret@example.com/config": true },
    { ...ordinary, packages: { ...ordinary.packages, "node_modules/link": { link: true, resolved: "../outside" } } },
    { ...ordinary, packages: { ...ordinary.packages, "node_modules/git-dependency": { resolved: "git+https://example.com/team/repository.git#main" } } },
  ]) {
    assert.throws(() => parseWith(unsafe), /credential|portable|linked|full revision/u);
  }
  const paths = (values: readonly string[]): Record<string, unknown> => ({
    ...ordinary,
    packages: Object.fromEntries([
      ["", ordinary.packages[""]],
      ...values.map((path) => [path, { version: "1.0.0" }]),
    ]),
  });
  assert.throws(() => parseWith(paths(["node_modules/Foo", "node_modules/foo"])), /case or Unicode-normalization path collision/u);
  assert.throws(() => parseWith(paths(["node_modules/é", "node_modules/e\u0301"])), /portable|Unicode-normalization/u);
  for (const path of [
    "node_modules/CON.txt",
    "node_modules/trailing.",
    "node_modules/trailing ",
    "node_modules/name:stream",
    "node_modules/name?query",
  ]) {
    assert.throws(() => parseWith(paths([path])), /portable/u);
  }
});

test("dependency lock snapshots cannot exceed the serialized project lock bound", () => {
  const packages = Array.from({ length: 7 }, (_, index) => ({
    id: `package-${index}`,
    source: { kind: "local" as const, path: `packages/package-${index}` },
  }));
  const declaration = parseProjectPackageDeclaration({ schemaVersion: 1, packages });
  const hash = "a".repeat(64);
  const content = `${canonicalJson({
    lockfileVersion: 3,
    packages: { "": { name: "package", version: "1.0.0", padding: "\\".repeat(920_000) } },
  })}\n`;
  const snapshot = { sha256: createHash("sha256").update(content).digest("hex"), content };

  assert.throws(() => parseProjectPackageLock({
    schemaVersion: 2,
    declarationSha256: projectPackageDeclarationSha256(declaration),
    packages: declaration.packages.map((entry) => ({
      id: entry.id,
      declaration: entry,
      resolved: {
        kind: "local",
        path: entry.source.kind === "local" ? entry.source.path : "unreachable",
        manifestSha256: hash,
        contentSha256: hash,
        dependencyLock: snapshot,
        dependencyContentSha256: hash,
      },
    })),
  }), /serialized bytes/u);
});

test("npm declarations lock an archive and reinstall only the exact resolved version", async (context) => {
  const value = await fixture(context);
  const fakeNpm = join(value.workspace, "fake-npm.mjs");
  await writeFile(fakeNpm, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
if (args[0] === "pack") {
  const spec = args[1];
  const exact = /@(\\d+\\.\\d+\\.\\d+)$/.exec(spec)?.[1];
  const version = exact ?? "1.2.3";
  const destination = args[args.indexOf("--pack-destination") + 1];
  const filename = "registry-package-" + version + ".tgz";
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, filename), "registry-package@" + version);
  await new Promise((resolve) => process.stdout.write(JSON.stringify([{ filename, name: "registry-package", version }]), resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.exit(0);
}
if (args[0] === "install") {
  const archive = fileURLToPath(args[1]);
  const version = readFileSync(archive, "utf8").split("@")[1];
  const root = args[args.indexOf("--prefix") + 1];
  const packageRoot = join(root, "node_modules", "registry-package");
  mkdirSync(join(packageRoot, "extensions"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "registry-package", version, type: "module", rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  writeFileSync(join(packageRoot, "extensions", "index.mjs"), "export default () => {};\\n");
  process.exit(0);
}
process.exit(2);
`);
  await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), JSON.stringify({
    schemaVersion: 1,
    packages: [{ id: "registry", source: { kind: "npm", package: "registry-package", selector: "latest" } }],
  }));
  const packages = new ProjectPackageManager({
    workspace: value.workspace,
    projectTrusted: true,
    operationLeaseRoot: value.leaseRoot,
    commands: { npm: { command: process.execPath, prefix: [fakeNpm] } },
  });

  const result = await packages.update({ all: true });
  assert.equal(result.packages[0]?.version, "1.2.3");
  assert.deepEqual(result.catalog[0]?.resolved, {
    kind: "npm",
    source: "npm:registry-package@1.2.3",
    packageName: "registry-package",
    resolvedVersion: "1.2.3",
    archiveSha256: createHash("sha256").update("registry-package@1.2.3").digest("hex"),
    manifestSha256: result.catalog[0]?.resolved.manifestSha256,
    contentSha256: result.catalog[0]?.resolved.contentSha256,
  });
  await rm(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT), { recursive: true });
  assert.equal((await packages.reconcile()).packages[0]?.version, "1.2.3");
});

test("Git declarations record and stage a full immutable revision", async (context) => {
  const value = await fixture(context);
  const fakeGit = join(value.workspace, "fake-git.mjs");
  const response = join(value.workspace, "fake-git-response.txt");
  const argvLog = join(value.workspace, "fake-git-argv.jsonl");
  const revision = "a".repeat(40);
  await writeFile(fakeGit, `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const response = args.shift();
const argvLog = args.shift();
appendFileSync(argvLog, JSON.stringify(args) + "\\n");
if (args.includes("clone")) {
  const root = args.at(-1);
  mkdirSync(join(root, "extensions"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "git-package", version: "1.0.0", type: "module", rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  writeFileSync(join(root, "extensions", "index.mjs"), "export default () => {};\\n");
  process.exit(0);
}
if (args.includes("ls-remote")) {
  writeFileSync(response, ${JSON.stringify(`${revision}\trefs/heads/main\n`)});
  process.exit(0);
}
if (args.includes("rev-parse")) {
  writeFileSync(response, ${JSON.stringify(revision)});
  process.exit(0);
}
process.exit(0);
`);
  await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), JSON.stringify({
    schemaVersion: 1,
    packages: [{
      id: "git-package",
      source: { kind: "git", repository: "https://example.com/team/git-package.git", ref: "main" },
    }],
  }));
  const packages = new ProjectPackageManager({
    workspace: value.workspace,
    projectTrusted: true,
    operationLeaseRoot: value.leaseRoot,
    commands: {
      git: {
        command: "bash",
        prefix: [
          "-c",
          'rm -f "$3"; "$1" "$2" "$3" "$4" "${@:5}"; status=$?; if [ -f "$3" ]; then command cat "$3"; fi; exit "$status"',
          "fake-git-wrapper",
          process.execPath,
          fakeGit,
          response,
          argvLog,
        ],
      },
    },
  });

  const result = await packages.update({ all: true });
  assert.equal(result.catalog[0]?.resolved.kind, "git");
  assert.equal(result.catalog[0]?.resolved.kind === "git" ? result.catalog[0].resolved.revision : undefined, revision);
  assert.equal(result.catalog[0]?.resolved.kind === "git" ? result.catalog[0].resolved.source : undefined,
    `git:https://example.com/team/git-package.git#${revision}`);
  const invocations = (await readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const fetch = invocations.find((argumentsValue) => argumentsValue.includes("fetch"));
  assert.deepEqual(fetch?.slice(-3), ["--", "origin", "refs/heads/main"]);
  for (const argumentsValue of invocations) {
    assert.ok(argumentsValue.some((argument) => argument.startsWith("core.hooksPath=")));
    assert.ok(argumentsValue.includes("core.fsmonitor=false"));
    assert.ok(argumentsValue.includes("credential.helper="));
    assert.ok(argumentsValue.includes("protocol.allow=never"));
    assert.ok(argumentsValue.includes("protocol.https.allow=always"));
  }
});

test("Git materialization ignores inherited hooks and checkout filters", async (context) => {
  const value = await fixture(context);
  const repository = join(value.workspace, "git-origin");
  const hooks = join(value.workspace, "hostile-hooks");
  const hookMarker = join(value.workspace, "hostile-hook-ran");
  const filterMarker = join(value.workspace, "hostile-filter-ran");
  const filter = join(value.workspace, "hostile-filter.sh");
  const globalConfig = join(value.workspace, "hostile-gitconfig");
  await mkdir(join(repository, "extensions"), { recursive: true });
  await writeFile(join(repository, "package.json"), `${JSON.stringify({
    name: "hardened-git-package",
    version: "1.0.0",
    type: "module",
    rigyn: { extensions: ["extensions/index.mjs"] },
  })}\n`);
  await writeFile(join(repository, "extensions", "index.mjs"), "export default () => {};\n");
  await writeFile(join(repository, ".gitattributes"), "filtered.txt filter=hostile\n");
  await writeFile(join(repository, "filtered.txt"), "safe checkout content\n");
  await execFile("git", ["init", "--quiet", repository]);
  await execFile("git", ["-C", repository, "add", "."]);
  await execFile("git", [
    "-C", repository,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "-m", "fixture",
  ]);
  const revision = (await execFile("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();

  await mkdir(hooks);
  await writeFile(join(hooks, "post-checkout"), `#!/bin/sh\nprintf ran > ${JSON.stringify(hookMarker)}\n`);
  await chmod(join(hooks, "post-checkout"), 0o700);
  await writeFile(filter, `#!/bin/sh\nprintf ran > ${JSON.stringify(filterMarker)}\ncat\n`);
  await chmod(filter, 0o700);
  await writeFile(globalConfig, `[core]\n\thooksPath = ${hooks}\n[filter "hostile"]\n\tsmudge = ${filter}\n\trequired = true\n`);
  const remote = "https://example.com/team/hardened-git-package.git";
  await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), JSON.stringify({
    schemaVersion: 1,
    packages: [{
      id: "hardened-git",
      source: { kind: "git", repository: remote, ref: revision },
    }],
  }));
  const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    const packages = new ProjectPackageManager({
      workspace: value.workspace,
      projectTrusted: true,
      operationLeaseRoot: value.leaseRoot,
      commands: {
        git: {
          command: "git",
          prefix: [
            "-c", `url.${pathToFileURL(repository).href}.insteadOf=${remote}`,
            "-c", "protocol.file.allow=always",
          ],
        },
      },
    });
    assert.equal((await packages.update({ all: true })).status, "ready");
  } finally {
    if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
  }
  await assert.rejects(access(hookMarker), /ENOENT/u);
  await assert.rejects(access(filterMarker), /ENOENT/u);
});

test("npm staging quota terminates an expanding command and removes temporary state", async (context) => {
  const value = await fixture(context);
  const fakeNpm = join(value.workspace, "expanding-npm.mjs");
  const started = join(value.workspace, "expanding-npm-started");
  await writePackage(value, "1.0.0");
  const manifest = JSON.parse(await readFile(join(value.source, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.dependencies = { expanding: "1.0.0" };
  await writeFile(join(value.source, "package.json"), `${JSON.stringify(manifest)}\n`);
  await writeDeclaration(value);
  await writeFile(fakeNpm, `
import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [started] = process.argv.slice(2);
writeFileSync(started, String(process.pid));
const root = process.env.npm_config_cache;
if (root === undefined) process.exit(3);
mkdirSync(root, { recursive: true });
const payload = join(root, "payload.bin");
writeFileSync(payload, "");
truncateSync(payload, 64 * 1024 * 1024 + 1);
setInterval(() => {}, 1_000);
`);
  const packages = new ProjectPackageManager({
    workspace: value.workspace,
    projectTrusted: true,
    operationLeaseRoot: value.leaseRoot,
    offline: true,
    commands: { npm: { command: process.execPath, prefix: [fakeNpm, started] } },
  });
  await assert.rejects(packages.update({ all: true }), /staging quota exceeds 67108864 bytes/u);
  const pid = Number(await readFile(started, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (
    error instanceof Error && "code" in error && error.code === "ESRCH"
  ));
  await assert.rejects(access(join(value.workspace, ".rigyn", ".packages-resolution")), /ENOENT/u);
  await assert.rejects(access(join(value.workspace, ".rigyn", ".packages-stage")), /ENOENT/u);
  await assert.rejects(access(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT)), /ENOENT/u);
});

test("npm staging quota counts empty directories and terminates the process tree", async (context) => {
  const value = await fixture(context);
  const fakeNpm = join(value.workspace, "directory-npm.mjs");
  const started = join(value.workspace, "directory-npm-started");
  await writePackage(value, "1.0.0");
  const manifest = JSON.parse(await readFile(join(value.source, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.dependencies = { expanding: "1.0.0" };
  await writeFile(join(value.source, "package.json"), `${JSON.stringify(manifest)}\n`);
  await writeDeclaration(value);
  await writeFile(fakeNpm, `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [started] = process.argv.slice(2);
writeFileSync(started, String(process.pid));
for (let index = 0; index <= 4096; index += 1) mkdirSync(join(process.cwd(), "empty-" + index));
setInterval(() => {}, 1_000);
`);
  const packages = new ProjectPackageManager({
    workspace: value.workspace,
    projectTrusted: true,
    operationLeaseRoot: value.leaseRoot,
    offline: true,
    commands: { npm: { command: process.execPath, prefix: [fakeNpm, started] } },
  });
  await assert.rejects(packages.update({ all: true }), /staging quota exceeds 4096 entries/u);
  const pid = Number(await readFile(started, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (
    error instanceof Error && "code" in error && error.code === "ESRCH"
  ));
  await assert.rejects(access(join(value.workspace, ".rigyn", ".packages-resolution")), /ENOENT/u);
  await assert.rejects(access(join(value.workspace, ".rigyn", ".packages-stage")), /ENOENT/u);
  await assert.rejects(access(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT)), /ENOENT/u);
});

test("production dependencies replay from a portable lock and detect installed-tree drift", async (context) => {
  const value = await fixture(context);
  const fakeNpm = join(value.workspace, "fake-dependency-npm.mjs");
  const commandLog = join(value.workspace, "dependency-npm-log.jsonl");
  const installOptional = join(value.workspace, "install-platform-optional");
  await writePackage(value, "1.0.0");
  const manifest = JSON.parse(await readFile(join(value.source, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.dependencies = { "required-dependency": "^1.0.0" };
  manifest.optionalDependencies = { "optional-dependency": "^2.0.0" };
  manifest.peerDependencies = { rigyn: "*", "peer-dependency": "^3.0.0" };
  manifest.devDependencies = { "dev-dependency": "^4.0.0" };
  manifest.peerDependenciesMeta = { "peer-dependency": { optional: false } };
  await writeFile(join(value.source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(join(value.source, "node_modules", "unverified"), { recursive: true });
  await writeFile(join(value.source, "node_modules", "unverified", "index.js"), "must not be copied\n");
  await writeFile(join(value.source, "npm-shrinkwrap.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  await writeDeclaration(value);
  await writeFile(fakeNpm, `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const log = args.shift();
const installOptional = args.shift();
const command = args[0];
const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
appendFileSync(log, JSON.stringify({
  args,
  offline: process.env.npm_config_offline,
  token: process.env.NPM_TOKEN,
  home: process.env.HOME,
  userConfig: process.env.npm_config_userconfig,
  globalConfig: process.env.npm_config_globalconfig,
  cache: process.env.npm_config_cache,
  temporary: process.env.TMPDIR,
  peerDependencies: manifest.peerDependencies,
}) + "\\n");
const versions = {
  "required-dependency": "1.4.0",
  "optional-dependency": "2.1.0",
  "libc-dependency": "2.2.0",
  "peer-dependency": "3.2.0",
  "dev-dependency": "4.1.0",
};
if (command === "install") {
  const packages = { "": {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
    devDependencies: manifest.devDependencies,
  } };
  for (const [name, version] of Object.entries(versions)) packages["node_modules/" + name] = {
    version,
    resolved: "https://registry.example/" + name + ".tgz",
    integrity: "sha512-safe",
    ...(name === "optional-dependency" ? { optional: true, os: ["never"] } : {}),
    ...(name === "libc-dependency" ? { libc: ["musl"] } : {}),
    ...(name === "peer-dependency" ? { peer: true } : {}),
    ...(name === "dev-dependency" ? { dev: true } : {}),
  };
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  }));
}
for (const [name, version] of Object.entries(versions)) {
  if (name === "dev-dependency" || name === "optional-dependency"
    || (name === "libc-dependency" && !existsSync(installOptional))
    || (name === "peer-dependency" && args.includes("--legacy-peer-deps"))) continue;
  const dependency = join(root, "node_modules", name);
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(dependency, "index.js"), "export default " + JSON.stringify(version) + ";\\n");
  if (name === "required-dependency") writeFileSync(join(dependency, "extension.json"), JSON.stringify({ unrelated: true }));
}
process.exit(command === "install" || command === "ci" ? 0 : 2);
`);
  const packages = new ProjectPackageManager({
    workspace: value.workspace,
    projectTrusted: true,
    operationLeaseRoot: value.leaseRoot,
    offline: true,
    commands: { npm: { command: process.execPath, prefix: [fakeNpm, commandLog, installOptional] } },
  });

  const hostileHome = join(value.workspace, "hostile-home");
  await mkdir(hostileHome);
  await writeFile(join(hostileHome, ".npmrc"), "//registry.example/:_authToken=ambient-secret\n");
  const priorEnvironment = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    NPM_TOKEN: process.env.NPM_TOKEN,
  };
  process.env.HOME = hostileHome;
  process.env.USERPROFILE = hostileHome;
  process.env.NPM_TOKEN = "ambient-secret";
  try {
    await packages.update({ all: true });
  } finally {
    for (const [name, selected] of Object.entries(priorEnvironment)) {
      if (selected === undefined) delete process.env[name];
      else process.env[name] = selected;
    }
  }
  const active = join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared");
  await assert.rejects(access(join(active, "npm-shrinkwrap.json")), /ENOENT/u);
  await assert.rejects(access(join(active, "node_modules", "unverified")), /ENOENT/u);
  await access(join(active, "node_modules", "required-dependency", "index.js"));
  await access(join(active, "node_modules", "peer-dependency", "index.js"));
  await assert.rejects(access(join(active, "node_modules", "rigyn")), /ENOENT/u);
  await assert.rejects(access(join(active, "node_modules", "optional-dependency")), /ENOENT/u);
  await assert.rejects(access(join(active, "node_modules", "libc-dependency")), /ENOENT/u);
  const lock = JSON.parse(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK), "utf8")) as {
    schemaVersion: number;
    packages: Array<{ resolved: { dependencyLock?: { sha256: string; content: string }; dependencyContentSha256?: string } }>;
  };
  assert.equal(lock.schemaVersion, 2);
  assert.match(lock.packages[0]?.resolved.dependencyLock?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.match(lock.packages[0]?.resolved.dependencyContentSha256 ?? "", /^[a-f0-9]{64}$/u);
  const firstProvenance = JSON.parse(await readFile(join(active, ".rigyn-package.json"), "utf8")) as {
    dependencyPlatformContentSha256?: string;
  };
  assert.match(firstProvenance.dependencyPlatformContentSha256 ?? "", /^[a-f0-9]{64}$/u);
  const calls = (await readFile(commandLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    args: string[];
    offline?: string;
    token?: string;
    home?: string;
    userConfig?: string;
    globalConfig?: string;
    cache?: string;
    temporary?: string;
    peerDependencies?: Record<string, string>;
  });
  assert.ok(calls.some((entry) => entry.args[0] === "install"));
  assert.ok(calls.some((entry) => entry.args[0] === "ci"));
  assert.ok(calls.every((entry) => entry.offline === "true" && entry.args.includes("--offline")));
  assert.ok(calls.every((entry) => !entry.args.includes("--legacy-peer-deps")));
  assert.ok(calls.every((entry) => entry.peerDependencies?.rigyn === undefined));
  assert.ok(calls.every((entry) => entry.token === undefined && entry.home !== hostileHome));
  for (const entry of calls) {
    for (const path of [entry.home, entry.userConfig, entry.globalConfig, entry.cache, entry.temporary]) {
      assert.ok(path !== undefined && resolve(path).startsWith(`${resolve(value.workspace, ".rigyn")}${sep}`));
    }
  }

  await writeFile(join(active, "node_modules", "required-dependency", "index.js"), "tampered\n");
  assert.equal((await packages.check()).status, "needs-reconcile");
  assert.equal((await packages.reconcile()).status, "ready");
  await mkdir(join(active, "node_modules", "extraneous"));
  assert.equal((await packages.check()).status, "needs-reconcile");
  assert.equal((await packages.reconcile()).status, "ready");
  await writeFile(installOptional, "present\n");
  await writeFile(join(active, "node_modules", "required-dependency", "index.js"), "force platform replay\n");
  await assert.rejects(packages.reconcile(), /platform attestation is invalid/u);
  await assert.rejects(access(join(active, "node_modules", "libc-dependency")), /ENOENT/u);
  await rm(installOptional);
  assert.equal((await packages.reconcile()).status, "ready");
  await writeFile(installOptional, "present\n");
  const declarationPath = join(value.workspace, PROJECT_PACKAGE_DECLARATION);
  const changedDeclaration = JSON.parse(await readFile(declarationPath, "utf8")) as {
    packages: Array<{ disabledResources?: string[] }>;
  };
  changedDeclaration.packages[0]!.disabledResources = ["prompt:platform-rotation"];
  await writeFile(declarationPath, `${JSON.stringify(changedDeclaration, null, 2)}\n`);
  assert.equal((await packages.update({ all: true })).status, "ready");
  await access(join(active, "node_modules", "libc-dependency", "index.js"));
  await rm(join(active, "node_modules", "libc-dependency"), { recursive: true });
  const forgedAbsent = JSON.parse(await readFile(join(active, ".rigyn-package.json"), "utf8")) as Record<string, unknown>;
  forgedAbsent.dependencyPlatformContentSha256 = firstProvenance.dependencyPlatformContentSha256;
  await writeFile(join(active, ".rigyn-package.json"), `${JSON.stringify(forgedAbsent, null, 2)}\n`);
  assert.equal((await packages.check()).status, "needs-reconcile");
  assert.equal((await packages.reconcile()).status, "ready");
  await mkdir(join(active, "node_modules", "dev-dependency"));
  await writeFile(join(active, "node_modules", "dev-dependency", "package.json"), JSON.stringify({
    name: "dev-dependency",
    version: "4.1.0",
  }));
  assert.equal((await packages.check()).status, "needs-reconcile");
  assert.equal((await packages.reconcile()).status, "ready");
  const outside = join(value.workspace, "outside-dependencies");
  await cp(join(active, "node_modules"), outside, { recursive: true });
  await rm(join(active, "node_modules"), { recursive: true });
  await symlink(outside, join(active, "node_modules"));
  assert.equal((await packages.check()).status, "needs-reconcile");
});

test("peer metadata names declared peers and the host peer must match this rigyn", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const path = join(value.source, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  manifest.peerDependenciesMeta = { constructor: { optional: true } };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(manager(value).update({ all: true }), /does not name a peer dependency/u);

  manifest.peerDependencies = { rigyn: ">=999.0.0" };
  manifest.peerDependenciesMeta = {};
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(manager(value).update({ all: true }), /requires rigyn/u);
});

test("offline remote updates fail before npm or Git commands run", async (context) => {
  const value = await fixture(context);
  const marker = join(value.workspace, "remote-command-ran");
  const command = join(value.workspace, "unexpected-remote-command.mjs");
  await writeFile(command, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(2);\n`);
  const commands = {
    npm: { command: process.execPath, prefix: [command] },
    git: { command: process.execPath, prefix: [command] },
  };
  const writeRemote = async (source: Record<string, unknown>): Promise<void> => {
    await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), JSON.stringify({
      schemaVersion: 1,
      packages: [{ id: "remote", source }],
    }));
  };

  await writeRemote({ kind: "npm", package: "remote-package", selector: "latest" });
  await assert.rejects(new ProjectPackageManager({
    workspace: value.workspace,
    projectTrusted: true,
    operationLeaseRoot: value.leaseRoot,
    offline: true,
    commands,
  }).update({ all: true }), /while offline/u);
  await assert.rejects(access(marker), /ENOENT/u);

  const previous = process.env.RIGYN_OFFLINE;
  process.env.RIGYN_OFFLINE = "true";
  try {
    await writeRemote({ kind: "git", repository: "https://example.com/team/remote.git", ref: "main" });
    await assert.rejects(new ProjectPackageManager({
      workspace: value.workspace,
      projectTrusted: true,
      operationLeaseRoot: value.leaseRoot,
      commands,
    }).update({ all: true }), /while offline/u);
  } finally {
    if (previous === undefined) delete process.env.RIGYN_OFFLINE;
    else process.env.RIGYN_OFFLINE = previous;
  }
  await assert.rejects(access(marker), /ENOENT/u);
});

test("intentional local updates lock content while reconciliation ignores later source edits", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const packages = manager(value);

  assert.equal((await packages.check()).status, "unlocked");
  const first = await packages.update({ all: true });
  assert.equal(first.packages[0]?.version, "1.0.0");
  assert.equal(first.changed, true);
  const firstLock = await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK));

  await writePackage(value, "2.0.0");
  const reconciled = await packages.reconcile();
  assert.equal(reconciled.changed, false);
  assert.equal(reconciled.packages[0]?.version, "1.0.0");
  assert.deepEqual(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK)), firstLock);

  const second = await packages.update({ ids: ["declared"] });
  assert.equal(second.packages[0]?.version, "2.0.0");
  assert.equal((await packages.check()).status, "ready");
  const active = join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared");
  await mkdir(join(active, "empty-directory"));
  assert.equal((await packages.check()).status, "needs-reconcile");
  assert.equal((await packages.reconcile()).status, "ready");
  await assert.rejects(access(join(active, "empty-directory")), /ENOENT/u);
  await assert.rejects(access(join(value.workspace, ".rigyn", ".packages-operation.lock")), /ENOENT/u);
  assert.deepEqual(await readdir(value.leaseRoot), []);
});

test("modern project packages treat unrelated malformed extension manifests as ordinary content", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeFile(join(value.source, "extension.json"), "not a legacy manifest\n");
  await writeDeclaration(value);
  const packages = manager(value);
  assert.equal((await packages.update({ all: true })).status, "ready");
  assert.equal((await packages.check()).status, "ready");
});

test("partial updates reject unrequested declaration additions and removals", async (context) => {
  const value = await fixture(context);
  const writeLocal = async (id: string): Promise<void> => {
    const root = join(value.workspace, `package-${id}`);
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: `package-${id}`,
      version: "1.0.0",
      type: "module",
      rigyn: { extensions: ["extensions/index.mjs"] },
    })}\n`);
    await writeFile(join(root, "extensions", "index.mjs"), "export default () => {};\n");
  };
  const writeSet = async (ids: readonly string[]): Promise<void> => {
    await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), `${JSON.stringify({
      schemaVersion: 1,
      packages: ids.map((id) => ({ id, source: { kind: "local", path: `package-${id}` } })),
    }, null, 2)}\n`);
  };
  await Promise.all([writeLocal("a"), writeLocal("b"), writeLocal("c")]);
  await writeSet(["a", "b"]);
  const packages = manager(value);
  await packages.update({ all: true });
  const lock = await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK));

  await writeSet(["a"]);
  await assert.rejects(packages.update({ ids: ["a"] }), /b changed outside.*use --all/u);
  assert.deepEqual(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK)), lock);
  assert.deepEqual((await readdir(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT))).sort(), ["a", "b"]);

  await writeSet(["a", "b", "c"]);
  await assert.rejects(packages.update({ ids: ["a"] }), /c is not locked.*use --all/u);
  assert.deepEqual(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK)), lock);
  assert.deepEqual((await readdir(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT))).sort(), ["a", "b"]);
});

test("external operation leases reap stale incomplete records and preserve replacement ownership", async (context) => {
  const value = await fixture(context);
  await mkdir(value.leaseRoot, { recursive: true });
  const lease = join(value.leaseRoot, `project-packages-${createHash("sha256").update(value.workspace).digest("hex")}.lock`);
  await writeFile(lease, "{}\n");
  const stale = new Date(Date.now() - 10_000);
  await utimes(lease, stale, stale);
  assert.equal((await manager(value).check()).status, "absent");
  await assert.rejects(access(lease), /ENOENT/u);

  await writePackage(value, "1.0.0", `
    export default async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    };
  `);
  await writeDeclaration(value);
  const operation = manager(value).update({ all: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(lease);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  await access(lease);
  const replacement = { schemaVersion: 1, pid: process.pid, token: "b".repeat(32) };
  await writeFile(lease, `${JSON.stringify(replacement)}\n`);
  await operation;
  assert.deepEqual(JSON.parse(await readFile(lease, "utf8")) as unknown, replacement);
  await rm(lease);
});

test("legacy lock installs remain read-only and migrate only through update all", async (context) => {
  const value = await fixture(context);
  const agentDir = join(value.workspace, "agent");
  await mkdir(join(value.source, "runtime"), { recursive: true });
  await mkdir(join(value.source, "other-runtime"), { recursive: true });
  await mkdir(join(value.source, "modern-runtime"), { recursive: true });
  await mkdir(join(value.source, "legacy-skills", "legacy-skill"), { recursive: true });
  await mkdir(join(value.source, "kept-skills", "kept-skill"), { recursive: true });
  await mkdir(join(value.source, "legacy-templates"), { recursive: true });
  await mkdir(join(value.source, "legacy-themes"), { recursive: true });
  const runtime = `export default (api) => { api.registerCommand("legacy-live", { handler() {} }); };\n`;
  const otherRuntime = `export default (api) => { api.registerCommand("legacy-second", { handler() {} }); };\n`;
  const modernRuntime = `export default (api) => { api.registerCommand("modern-wrong", { handler() {} }); };\n`;
  await writeFile(join(value.source, "runtime", "entry.mjs"), runtime);
  await writeFile(join(value.source, "other-runtime", "entry.mjs"), otherRuntime);
  await writeFile(join(value.source, "modern-runtime", "entry.mjs"), modernRuntime);
  await writeFile(join(value.source, "package.json"), `${JSON.stringify({
    name: "My Package",
    version: "9.0.0",
    description: { unrelated: true },
    type: "module",
    rigyn: { extensions: ["modern-runtime/entry.mjs"] },
  }, null, 2)}\n`);
  await writeFile(join(value.source, "legacy-skills", "legacy-skill", "SKILL.md"), "---\nname: legacy-skill\ndescription: Legacy skill\n---\nLegacy instructions\n");
  await writeFile(join(value.source, "kept-skills", "kept-skill", "SKILL.md"), "---\nname: kept-skill\ndescription: Kept skill\n---\nKept instructions\n");
  await writeFile(join(value.source, "legacy-templates", "shared.md"), "Legacy shared body\n");
  await writeFile(join(value.source, "legacy-templates", "kept.md"), "Legacy kept prompt body\n");
  await writeFile(join(value.source, "legacy-themes", "ocean.json"), `${JSON.stringify({
    schemaVersion: 1,
    name: "legacy-ocean",
    base: "dark",
    styles: { accent: { foreground: 33 } },
  }, null, 2)}\n`);
  await writeFile(join(value.source, "legacy-themes", "sunset.json"), `${JSON.stringify({
    schemaVersion: 1,
    name: "legacy-sunset",
    base: "dark",
    styles: { accent: { foreground: 35 } },
  }, null, 2)}\n`);
  const extensionManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    id: "declared",
    name: "Legacy declared package",
    version: "1.0.0",
    description: "Shipped extension manifest fixture",
    compatibility: { hostVersion: ">=0.1.0" },
    permissions: { unsafeTerminal: true },
    integrity: {
      "runtime/entry.mjs": createHash("sha256").update(runtime).digest("hex"),
      "other-runtime/entry.mjs": createHash("sha256").update(otherRuntime).digest("hex"),
    },
    contributions: {
      skillRoots: [{ path: "legacy-skills" }, { path: "kept-skills" }],
      prompts: [
        { id: "legacy-prompt", path: "legacy-templates/shared.md", description: "Disabled declared prompt" },
        { id: "legacy-kept", path: "legacy-templates/kept.md", description: "Declared prompt" },
      ],
      commands: [{ name: "legacy-command", path: "legacy-templates/shared.md", description: "Declared command", argumentHint: "<target>" }],
      themes: [
        { name: "legacy-ocean", path: "legacy-themes/ocean.json", description: "Disabled declared theme" },
        { name: "legacy-sunset", path: "legacy-themes/sunset.json", description: "Declared theme" },
      ],
      runtime: [{ path: "runtime/entry.mjs" }, { path: "other-runtime/entry.mjs" }],
    },
  }, null, 2)}\n`);
  await writeFile(join(value.source, "extension.json"), extensionManifest);
  await writeDeclaration(value, ["skill:legacy-skills", "prompt:legacy-prompt", "theme:legacy-ocean"]);
  const active = join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared");
  await mkdir(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT), { recursive: true });
  await cp(value.source, active, { recursive: true });
  await writeFile(join(active, "package-lock.json"), "legacy lock bytes\n");
  await writeFile(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, ".rigyn-packages.lock"), "ignored root residue\n");
  await mkdir(join(active, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(active, "node_modules", "ignored", "index.js"), "ignored dependency bytes\n");
  const manifest = await readFile(join(active, "extension.json"));
  const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
  await writeFile(join(active, ".rigyn-package.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "declared",
    scope: "project",
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    manifestSha256,
    kind: "local",
    sourcePath: value.source,
  }, null, 2)}\n`);
  const declaration = parseProjectPackageDeclaration(JSON.parse(
    await readFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), "utf8"),
  ) as unknown);
  const lock = {
    schemaVersion: 1,
    declarationSha256: projectPackageDeclarationSha256(declaration),
    packages: [{
      id: "declared",
      declaration: declaration.packages[0],
      resolved: {
        kind: "local",
        path: "package-source",
        manifestSha256,
        contentSha256: await legacyContentSha256(active),
      },
    }],
  };
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(join(value.workspace, PROJECT_PACKAGE_LOCK), lockBytes);
  const packages = manager(value);

  const checked = await packages.check();
  assert.equal(checked.status, "ready");
  assert.match(checked.message, /update --all/u);
  assert.equal((await packages.reconcile()).changed, false);
  assert.deepEqual(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK)), lockBytes);
  await assert.rejects(packages.update({ ids: ["declared"] }), /require.*update --all/u);

  const settings = SettingsManager.create(value.workspace, agentDir, { projectTrusted: true });
  await settings.reload();
  const loader = new DefaultResourceLoader({ cwd: value.workspace, agentDir, settingsManager: settings });
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  await loader.reload();
  const legacyHost = getExtensionRuntimeHost(loader.getExtensions().runtime);
  assert.deepEqual(legacyHost?.extensions().map((entry) => entry.extensionId), ["declared", "declared"]);
  assert.deepEqual(legacyHost?.commands().map((entry) => entry.name).sort(), ["legacy-live", "legacy-second"]);
  assert.deepEqual(loader.getSkills().skills.map((entry) => entry.name), ["kept-skill"]);
  assert.deepEqual(loader.getPrompts().prompts.map((entry) => ({
    name: entry.name,
    description: entry.description,
    argumentHint: entry.argumentHint,
  })).sort((left, right) => left.name.localeCompare(right.name)), [
    { name: "legacy-command", description: "Declared command", argumentHint: "<target>" },
    { name: "legacy-kept", description: "Declared prompt", argumentHint: undefined },
  ]);
  assert.deepEqual(loader.getThemes().themes.map((entry) => ({ name: entry.name, description: entry.description })), [
    { name: "legacy-sunset", description: "Declared theme" },
  ]);

  await writeFile(join(active, "runtime", "entry.mjs"), "corrupt\n");
  const corrupt = await packages.check();
  assert.equal(corrupt.status, "needs-reconcile");
  assert.match(corrupt.message, /update --all/u);
  await assert.rejects(packages.reconcile(), /cannot be repaired.*update --all/u);

  await writeFile(join(value.source, "runtime", "entry.mjs"), "source integrity mismatch\n");
  await assert.rejects(packages.update({ all: true }), /integrity mismatch/u);
  assert.deepEqual(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK)), lockBytes);
  assert.equal(await readFile(join(active, "runtime", "entry.mjs"), "utf8"), "corrupt\n");
  await writeFile(join(value.source, "runtime", "entry.mjs"), runtime);
  const migrated = await packages.update({ all: true });
  assert.equal(migrated.packages[0]?.version, "1.0.0");
  const migratedLock = JSON.parse(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK), "utf8")) as { schemaVersion: number };
  assert.equal(migratedLock.schemaVersion, 2);
  assert.deepEqual(await readFile(join(value.source, "extension.json")), extensionManifest);
  await loader.reload();
  const migratedHost = getExtensionRuntimeHost(loader.getExtensions().runtime);
  assert.deepEqual(migratedHost?.commands().map((entry) => entry.name).sort(), ["legacy-live", "legacy-second"]);
  const migratedIds = migratedHost?.extensions().map((entry) => entry.extensionId) ?? [];
  assert.deepEqual(migratedIds, ["declared", "declared"]);
  assert.deepEqual(loader.getSkills().skills.map((entry) => entry.name), ["kept-skill"]);
});

test("legacy npm and Git provenance accepts moving declarations while locks stay immutable", async (context) => {
  const value = await fixture(context);
  const revision = "a".repeat(40);
  const archiveSha256 = "b".repeat(64);
  const repository = "ssh://alice@example.com/team/legacy-package.git";
  const declarationValue = {
    schemaVersion: 1,
    packages: [
      { id: "git-legacy", source: { kind: "git", repository, ref: "main" } },
      { id: "npm-legacy", source: { kind: "npm", package: "registry-package", selector: "latest" } },
    ],
  } as const;
  await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), `${JSON.stringify(declarationValue, null, 2)}\n`);
  const declaration = {
    schemaVersion: 1 as const,
    packages: declarationValue.packages.map((entry) => ({ ...entry, disabledResources: [] })),
  };
  const installRoot = join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT);
  await mkdir(installRoot, { recursive: true });
  const lockPackages: Array<Record<string, unknown>> = [];
  for (const entry of declaration.packages) {
    const packageRoot = join(installRoot, entry.id);
    await mkdir(packageRoot);
    const manifest = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      id: entry.id,
      name: entry.id,
      version: entry.id === "npm-legacy" ? "1.2.3" : "2.0.0",
      contributions: {},
    }, null, 2)}\n`);
    await writeFile(join(packageRoot, "extension.json"), manifest);
    const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
    const resolved = entry.source.kind === "npm" ? {
      kind: "npm",
      source: "npm:registry-package@1.2.3",
      packageName: "registry-package",
      resolvedVersion: "1.2.3",
      archiveSha256,
      manifestSha256,
      contentSha256: "",
    } : {
      kind: "git",
      source: `git:${repository}#${revision}`,
      revision,
      manifestSha256,
      contentSha256: "",
    };
    await writeFile(join(packageRoot, ".rigyn-package.json"), `${JSON.stringify(entry.source.kind === "npm" ? {
      schemaVersion: 1,
      id: entry.id,
      scope: "project",
      installedAt: "2026-01-01T00:00:00.000Z",
      manifestSha256,
      kind: "npm",
      source: "npm:registry-package@latest",
      packageName: "registry-package",
      resolvedVersion: "1.2.3",
      archiveSha256,
    } : {
      schemaVersion: 1,
      id: entry.id,
      scope: "project",
      installedAt: "2026-01-01T00:00:00.000Z",
      manifestSha256,
      kind: "git",
      source: `git:${repository}#main`,
      revision,
    }, null, 2)}\n`);
    resolved.contentSha256 = await legacyContentSha256(packageRoot);
    lockPackages.push({ id: entry.id, declaration: entry, resolved });
  }
  await writeFile(join(value.workspace, PROJECT_PACKAGE_LOCK), `${JSON.stringify({
    schemaVersion: 1,
    declarationSha256: projectPackageDeclarationSha256(declaration),
    packages: lockPackages,
  }, null, 2)}\n`);

  const packages = manager(value);
  assert.equal((await packages.check()).status, "ready");
  assert.equal((await packages.reconcile()).changed, false);
  const installed = (await packages.reconcile()).packages;
  assert.equal(installed.find((entry) => entry.id === "npm-legacy")?.provenance.kind, "npm");
  assert.equal(installed.find((entry) => entry.id === "git-legacy")?.provenance.kind, "git");
});

test("unlocked legacy declarations migrate SSH users and keep non-normalized filters inert", async (context) => {
  const value = await fixture(context);
  const fakeGit = join(value.workspace, "legacy-git.mjs");
  const commandLog = join(value.workspace, "legacy-git-log.jsonl");
  const response = join(value.workspace, "legacy-git-response");
  await writeFile(fakeGit, `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const response = args.shift();
const log = args.shift();
appendFileSync(log, JSON.stringify(args) + "\\n");
writeFileSync(response, args.includes("ls-remote")
  ? "cccccccccccccccccccccccccccccccccccccccc\\trefs/heads/main\\n"
  : "cccccccccccccccccccccccccccccccccccccccc\\n");
if (args.includes("clone")) {
  const target = args.at(-1);
  mkdirSync(join(target, "runtime"), { recursive: true });
  writeFileSync(join(target, "runtime", "index.mjs"), 'export default (api) => api.registerCommand("legacy-unlocked", { handler() {} });\\n');
  writeFileSync(join(target, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "legacy-unlocked",
    name: "Legacy unlocked",
    version: "1.0.0",
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));
}
`);
  await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), `${JSON.stringify({
    schemaVersion: 1,
    packages: [{
      id: "legacy-unlocked",
      source: { kind: "git", repository: "alice@example.com:team/legacy.git", ref: "main" },
      disabledResources: ["runtime:./runtime/index.mjs"],
    }],
  }, null, 2)}\n`);
  const packages = new ProjectPackageManager({
    workspace: value.workspace,
    projectTrusted: true,
    operationLeaseRoot: value.leaseRoot,
    commands: { git: {
      command: "bash",
      prefix: [
        "-c",
        'rm -f "$3"; "$1" "$2" "$3" "$4" "${@:5}"; status=$?; if [ -f "$3" ]; then command cat "$3"; fi; exit "$status"',
        "fake-git-wrapper",
        process.execPath,
        fakeGit,
        response,
        commandLog,
      ],
    } },
  });
  assert.equal((await packages.check()).status, "unlocked");
  await packages.update({ all: true });
  const lock = JSON.parse(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK), "utf8")) as {
    schemaVersion: number;
    declarationGrammar?: string;
  };
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.declarationGrammar, "legacy");
  const calls = (await readFile(commandLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.ok(calls.every((args) => args.includes("protocol.ssh.allow=always")));

  const agentDir = join(value.workspace, "agent");
  const settings = SettingsManager.create(value.workspace, agentDir, { projectTrusted: true });
  await settings.reload();
  const loader = new DefaultResourceLoader({ cwd: value.workspace, agentDir, settingsManager: settings });
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  await loader.reload();
  assert.deepEqual(getExtensionRuntimeHost(loader.getExtensions().runtime)?.commands().map((entry) => entry.name), [
    "legacy-unlocked",
  ]);
});

test("legacy migration canonicalizes ordering and maps non-portable package directories for v2", async (context) => {
  const value = await fixture(context);
  const ids = ["a-", "a.", "a0", "a_", "con", "trail."];
  const filters = ["prompt:a-", "prompt:a.", "prompt:a0", "prompt:a_"];
  const declarations = ids.map((id) => ({
    id,
    source: { kind: "local" as const, path: `source-${id}` },
    disabledResources: [...filters].sort((left, right) => left.localeCompare(right)),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const portable = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  assert.notDeepEqual(declarations.map((entry) => entry.id), [...ids].sort(portable));
  const legacyDeclaration = { schemaVersion: 1 as const, packages: declarations };
  await writeFile(join(value.workspace, PROJECT_PACKAGE_DECLARATION), `${JSON.stringify({
    schemaVersion: 1,
    packages: ids.map((id) => ({
      id,
      source: { kind: "local", path: `source-${id}` },
      disabledResources: filters,
    })),
  }, null, 2)}\n`);

  const installRoot = join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT);
  await mkdir(installRoot, { recursive: true });
  const lockPackages: Array<Record<string, unknown>> = [];
  for (const declaration of declarations) {
    const sourceRoot = join(value.workspace, declaration.source.path);
    const packageRoot = join(installRoot, declaration.id);
    await mkdir(sourceRoot);
    await mkdir(packageRoot);
    const manifest = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      id: declaration.id,
      name: declaration.id,
      version: "1.0.0",
      contributions: {},
    }, null, 2)}\n`);
    await writeFile(join(sourceRoot, "extension.json"), manifest);
    await writeFile(join(packageRoot, "extension.json"), manifest);
    const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
    await writeFile(join(packageRoot, ".rigyn-package.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: declaration.id,
      scope: "project",
      installedAt: "2026-01-01T00:00:00.000Z",
      manifestSha256,
      kind: "local",
      sourcePath: sourceRoot,
    }, null, 2)}\n`);
    lockPackages.push({
      id: declaration.id,
      declaration,
      resolved: {
        kind: "local",
        path: declaration.source.path,
        manifestSha256,
        contentSha256: await legacyContentSha256(packageRoot),
      },
    });
  }
  await writeFile(join(value.workspace, PROJECT_PACKAGE_LOCK), `${JSON.stringify({
    schemaVersion: 1,
    declarationSha256: projectPackageDeclarationSha256(legacyDeclaration),
    packages: lockPackages,
  }, null, 2)}\n`);

  const packages = manager(value);
  assert.equal((await packages.check()).status, "ready");
  await packages.update({ all: true });
  const migrated = JSON.parse(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK), "utf8")) as {
    schemaVersion: number;
    declarationGrammar?: string;
    packages: Array<{ id: string; declaration: { disabledResources: string[] } }>;
  };
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.declarationGrammar, "legacy");
  assert.deepEqual(migrated.packages.map((entry) => entry.id), [...ids].sort(portable));
  assert.ok(migrated.packages.every((entry) => (
    JSON.stringify(entry.declaration.disabledResources) === JSON.stringify([...filters].sort(portable))
  )));
  const installedNames = (await readdir(installRoot)).sort(portable);
  assert.ok(installedNames.includes("_con"));
  assert.ok(installedNames.includes("_trail._"));
  assert.ok(!installedNames.includes("con") && !installedNames.includes("trail."));
  assert.equal((await packages.check()).status, "ready");
});

test("valid disabled and host-incompatible extension manifests remain intentionally inert", async (context) => {
  const value = await fixture(context);
  const agentDir = join(value.workspace, "agent");
  await mkdir(join(value.source, "runtime"), { recursive: true });
  await writeFile(join(value.source, "runtime", "entry.mjs"), "throw new Error('inert runtime activated');\n");
  const writeManifest = async (gate: { enabled?: boolean; compatibility?: { hostVersion: string } }): Promise<void> => {
    await writeFile(join(value.source, "extension.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "declared",
      name: "Inert package",
      version: "1.0.0",
      ...gate,
      contributions: { runtime: [{ path: "runtime/entry.mjs" }] },
    }, null, 2)}\n`);
  };
  await writeDeclaration(value);
  await writeManifest({ enabled: false });
  const packages = manager(value);
  assert.equal((await packages.update({ all: true })).status, "ready");

  const settings = SettingsManager.create(value.workspace, agentDir, { projectTrusted: true });
  await settings.reload();
  const loader = new DefaultResourceLoader({ cwd: value.workspace, agentDir, settingsManager: settings });
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  await loader.reload();
  assert.deepEqual(getExtensionRuntimeHost(loader.getExtensions().runtime)?.extensions(), []);

  await writeManifest({ compatibility: { hostVersion: ">=999.0.0" } });
  assert.equal((await packages.update({ all: true })).status, "ready");
  await loader.reload();
  assert.deepEqual(getExtensionRuntimeHost(loader.getExtensions().runtime)?.extensions(), []);
});

test("transaction recovery rolls replacement crash points back until the target lock commits", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const packages = manager(value);
  await packages.update({ all: true });

  const active = join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT);
  const stage = join(value.workspace, ".rigyn", ".packages-stage");
  const backup = join(value.workspace, ".rigyn", ".packages-backup");
  const transaction = join(value.workspace, ".rigyn", ".packages-transaction.json");
  const lockPath = join(value.workspace, PROJECT_PACKAGE_LOCK);
  const previousTemplate = join(value.workspace, "previous-install");
  const targetTemplate = join(value.workspace, "target-install");
  const previousLock = await readFile(lockPath);
  await cp(active, previousTemplate, { recursive: true });

  await writePackage(value, "2.0.0");
  await packages.update({ all: true });
  const targetLock = await readFile(lockPath);
  const targetLockSha256 = createHash("sha256").update(targetLock).digest("hex");
  await cp(active, targetTemplate, { recursive: true });

  type PackageSet = "previous" | "target";
  const template = (set: PackageSet): string => set === "previous" ? previousTemplate : targetTemplate;
  const versionAt = async (root: string): Promise<string> => {
    const manifest = JSON.parse(await readFile(join(root, "declared", "package.json"), "utf8")) as { version: string };
    return manifest.version;
  };
  const absent = async (path: string): Promise<void> => {
    await assert.rejects(access(path), /ENOENT/u);
  };
  const arrange = async (layout: {
    phase: "prepared" | "backed-up" | "activated";
    active?: PackageSet;
    stage?: PackageSet;
    backup?: PackageSet;
    lock: PackageSet;
  }): Promise<void> => {
    await Promise.all([
      rm(active, { recursive: true, force: true }),
      rm(stage, { recursive: true, force: true }),
      rm(backup, { recursive: true, force: true }),
      rm(transaction, { force: true }),
      rm(lockPath, { force: true }),
    ]);
    if (layout.active !== undefined) await cp(template(layout.active), active, { recursive: true });
    if (layout.stage !== undefined) await cp(template(layout.stage), stage, { recursive: true });
    if (layout.backup !== undefined) await cp(template(layout.backup), backup, { recursive: true });
    await writeFile(lockPath, layout.lock === "previous" ? previousLock : targetLock);
    await writeFile(transaction, `${JSON.stringify({
      schemaVersion: 1,
      targetLockSha256,
      phase: layout.phase,
    })}\n`);
  };
  const assertRecovered = async (expectedVersion: string): Promise<void> => {
    assert.equal((await packages.check()).status, "ready");
    assert.equal(await versionAt(active), expectedVersion);
    await absent(stage);
    await absent(backup);
    await absent(transaction);
  };

  await context.test("prepared before active moves preserves the previous active set", async () => {
    await arrange({ phase: "prepared", active: "previous", stage: "target", lock: "previous" });
    await assertRecovered("1.0.0");
  });

  await context.test("prepared after active moves restores the backup", async () => {
    await arrange({ phase: "prepared", stage: "target", backup: "previous", lock: "previous" });
    await assertRecovered("1.0.0");
  });

  await context.test("backed-up before staged activation restores the backup", async () => {
    await arrange({ phase: "backed-up", stage: "target", backup: "previous", lock: "previous" });
    await assertRecovered("1.0.0");
  });

  await context.test("backed-up after staged activation discards the target and restores the backup", async () => {
    await arrange({ phase: "backed-up", active: "target", backup: "previous", lock: "previous" });
    await assertRecovered("1.0.0");
  });

  for (const stalePhase of ["prepared", "backed-up"] as const) {
    await context.test(`${stalePhase} marker after target lock persistence keeps the validated target`, async () => {
      await arrange({ phase: stalePhase, active: "target", backup: "previous", lock: "target" });
      await assertRecovered("2.0.0");
    });
  }

  await context.test("stale prepared marker with a committed corrupt target fails closed", async () => {
    await arrange({ phase: "prepared", active: "target", backup: "previous", lock: "target" });
    await writeFile(join(active, "declared", "extensions", "index.mjs"), "corrupt target\n");
    await assert.rejects(packages.check(), /content digest/u);
    assert.equal(await versionAt(active), "2.0.0");
    assert.equal(await versionAt(backup), "1.0.0");
    await access(transaction);
  });

  await context.test("activated before lock write restores the backup", async () => {
    await arrange({ phase: "activated", active: "target", backup: "previous", lock: "previous" });
    await assertRecovered("1.0.0");
  });

  await context.test("activated after lock write keeps the target and removes the backup", async () => {
    await arrange({ phase: "activated", active: "target", backup: "previous", lock: "target" });
    await assertRecovered("2.0.0");
  });

  await context.test("cleanup resumes after the backup is already removed", async () => {
    await arrange({ phase: "activated", active: "target", lock: "target" });
    await assertRecovered("2.0.0");
  });

  await context.test("a missing marker keeps an active set that matches the current lock", async () => {
    await arrange({ phase: "activated", active: "previous", backup: "target", lock: "previous" });
    await rm(transaction);
    await assertRecovered("1.0.0");
  });

  await context.test("a missing marker restores a backup only after it matches the current lock", async () => {
    await arrange({ phase: "activated", active: "target", backup: "previous", lock: "previous" });
    await rm(transaction);
    await assertRecovered("1.0.0");
  });

  await context.test("a missing marker restores a matching backup when active is absent", async () => {
    await arrange({ phase: "activated", backup: "previous", lock: "previous" });
    await rm(transaction);
    await assertRecovered("1.0.0");
  });

  await context.test("a missing marker preserves both package sets when neither matches", async () => {
    await arrange({ phase: "activated", active: "target", backup: "target", lock: "previous" });
    await rm(transaction);
    await assert.rejects(packages.check(), /package sets were preserved|manual recovery/u);
    assert.equal(await versionAt(active), "2.0.0");
    assert.equal(await versionAt(backup), "2.0.0");
  });

  await context.test("a missing marker and lock preserve a backup for manual recovery", async () => {
    await arrange({ phase: "activated", backup: "previous", lock: "previous" });
    await Promise.all([rm(transaction), rm(lockPath)]);
    await assert.rejects(packages.check(), /without a transaction marker or lock|manual recovery/u);
    await absent(active);
    assert.equal(await versionAt(backup), "1.0.0");
  });

  await context.test("a committed target with no active set never restores the old backup", async () => {
    await arrange({ phase: "activated", backup: "previous", lock: "target" });
    await assert.rejects(packages.check(), /missing its active package set/u);
    await absent(active);
    assert.equal(await versionAt(backup), "1.0.0");
    await access(transaction);
  });
});

test("transaction recovery handles first-install crashes without inventing a prior package set", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const packages = manager(value);
  await packages.update({ all: true });

  const active = join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT);
  const stage = join(value.workspace, ".rigyn", ".packages-stage");
  const backup = join(value.workspace, ".rigyn", ".packages-backup");
  const transaction = join(value.workspace, ".rigyn", ".packages-transaction.json");
  const lockPath = join(value.workspace, PROJECT_PACKAGE_LOCK);
  const targetTemplate = join(value.workspace, "target-install");
  const targetLock = await readFile(lockPath);
  const targetLockSha256 = createHash("sha256").update(targetLock).digest("hex");
  await cp(active, targetTemplate, { recursive: true });

  const absent = async (path: string): Promise<void> => {
    await assert.rejects(access(path), /ENOENT/u);
  };
  const arrange = async (phase: "prepared" | "backed-up" | "activated", location: "stage" | "active", committed: boolean): Promise<void> => {
    await Promise.all([
      rm(active, { recursive: true, force: true }),
      rm(stage, { recursive: true, force: true }),
      rm(backup, { recursive: true, force: true }),
      rm(transaction, { force: true }),
      rm(lockPath, { force: true }),
    ]);
    await cp(targetTemplate, location === "stage" ? stage : active, { recursive: true });
    if (committed) await writeFile(lockPath, targetLock);
    await writeFile(transaction, `${JSON.stringify({ schemaVersion: 1, targetLockSha256, phase })}\n`);
  };
  const assertRolledBack = async (): Promise<void> => {
    assert.equal((await packages.check()).status, "unlocked");
    await absent(active);
    await absent(stage);
    await absent(backup);
    await absent(transaction);
  };

  await context.test("prepared removes the staged first install", async () => {
    await arrange("prepared", "stage", false);
    await assertRolledBack();
  });

  await context.test("backed-up after activation removes the uncommitted first install", async () => {
    await arrange("backed-up", "active", false);
    await assertRolledBack();
  });

  await context.test("activated before lock write removes the uncommitted first install", async () => {
    await arrange("activated", "active", false);
    await assertRolledBack();
  });

  await context.test("activated after lock write keeps the first install", async () => {
    await arrange("activated", "active", true);
    assert.equal((await packages.check()).status, "ready");
    await access(join(active, "declared", "package.json"));
    await absent(backup);
    await absent(transaction);
  });
});

test("failed whole-set activation and cancellation preserve the prior lock and active package", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const packages = manager(value);
  await packages.update({ all: true });
  const before = await Promise.all([
    readFile(join(value.workspace, PROJECT_PACKAGE_LOCK)),
    readFile(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "package.json")),
    readFile(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "extensions", "index.mjs")),
  ]);

  await writePackage(value, "2.0.0", `export default () => { throw new Error("project candidate rejected"); };\n`);
  await assert.rejects(packages.update({ all: true }), /project candidate rejected/u);
  assert.deepEqual(await Promise.all([
    readFile(join(value.workspace, PROJECT_PACKAGE_LOCK)),
    readFile(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "package.json")),
    readFile(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "extensions", "index.mjs")),
  ]), before);

  const controller = new AbortController();
  controller.abort(new Error("cancel project package update"));
  await assert.rejects(packages.update({ all: true, signal: controller.signal }), /cancel project package update/u);
  assert.deepEqual(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK)), before[0]);
});

test("cancellation in the final post-validation window never commits the staged set", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const packages = manager(value);
  await packages.update({ all: true });
  const lockPath = join(value.workspace, PROJECT_PACKAGE_LOCK);
  const activeManifest = join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "package.json");
  const before = await Promise.all([readFile(lockPath), readFile(activeManifest)]);
  await writePackage(value, "2.0.0");

  const implementation = (await readFile(new URL("../../src/extensions/project-packages.ts", import.meta.url), "utf8"))
    .replace(/\r\n?/gu, "\n");
  const boundary = "await this.#assertInputsUnchanged(sourceDeclarationSha256, sourceLockSha256);\n        options.signal?.throwIfAborted();";
  const boundaryIndex = implementation.indexOf(boundary);
  assert.notEqual(boundaryIndex, -1);
  const abortIndex = boundaryIndex + boundary.indexOf("options.signal?.throwIfAborted();");
  const abortLine = implementation.slice(0, abortIndex).split("\n").length;
  const controller = new AbortController();
  const nativeThrowIfAborted = controller.signal.throwIfAborted.bind(controller.signal);
  let coordinated = false;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    configurable: true,
    value: () => {
      if (!coordinated && (new Error().stack ?? "").includes(`project-packages.ts:${abortLine}:`)) {
        coordinated = true;
        controller.abort(new Error("cancel at final commit boundary"));
      }
      nativeThrowIfAborted();
    },
  });

  await assert.rejects(packages.update({ all: true, signal: controller.signal }), /cancel at final commit boundary/u);
  assert.equal(coordinated, true);
  assert.deepEqual(await Promise.all([readFile(lockPath), readFile(activeManifest)]), before);
  await assert.rejects(access(join(value.workspace, ".rigyn", ".packages-stage")), /ENOENT/u);
  await assert.rejects(access(join(value.workspace, ".rigyn", ".packages-transaction.json")), /ENOENT/u);
});

test("post-activation source mutation and concurrent input edits never commit a candidate", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const packages = manager(value);
  await packages.update({ all: true });
  const lockPath = join(value.workspace, PROJECT_PACKAGE_LOCK);
  const declarationPath = join(value.workspace, PROJECT_PACKAGE_DECLARATION);
  const activeEntry = join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT, "declared", "extensions", "index.mjs");
  const priorLock = await readFile(lockPath);
  const priorDeclaration = await readFile(declarationPath);
  const priorActive = await readFile(activeEntry);

  await writePackage(value, "2.0.0", `
    import { writeFileSync } from "node:fs";
    export default () => writeFileSync(new URL("mutation.txt", import.meta.url), "mutated\\n");
  `);
  await assert.rejects(packages.update({ all: true }), /content digest/u);
  assert.deepEqual(await readFile(lockPath), priorLock);
  assert.deepEqual(await readFile(activeEntry), priorActive);

  const changedDeclaration = JSON.parse(priorDeclaration.toString("utf8")) as {
    packages: Array<{ disabledResources?: string[] }>;
  };
  changedDeclaration.packages[0]!.disabledResources = ["prompt:changed.md"];
  await writePackage(value, "3.0.0", `
    import { writeFileSync } from "node:fs";
    export default () => writeFileSync(${JSON.stringify(declarationPath)}, ${JSON.stringify(`${JSON.stringify(changedDeclaration)}\n`)});
  `);
  await assert.rejects(packages.update({ all: true }), /declaration or lock changed/u);
  assert.deepEqual(await readFile(lockPath), priorLock);
  assert.deepEqual(await readFile(activeEntry), priorActive);
  await writeFile(declarationPath, priorDeclaration);

  const competingLock = "{}\n";
  await writePackage(value, "4.0.0", `
    import { writeFileSync } from "node:fs";
    export default () => writeFileSync(${JSON.stringify(lockPath)}, ${JSON.stringify(competingLock)});
  `);
  await assert.rejects(packages.update({ all: true }), /lock|unknown keys/u);
  assert.equal(await readFile(lockPath, "utf8"), competingLock);
  assert.deepEqual(await readFile(activeEntry), priorActive);
});

test("symbolic links in local package content are rejected without changing active state", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const packages = manager(value);
  await packages.update({ all: true });
  const before = await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK));
  await rm(join(value.source, "extensions", "index.mjs"));
  await writeFile(join(value.workspace, "outside.mjs"), "export default () => {};\n");
  await symlink(join(value.workspace, "outside.mjs"), join(value.source, "extensions", "index.mjs"));

  await assert.rejects(packages.update({ all: true }), /symbolic link/u);
  assert.deepEqual(await readFile(join(value.workspace, PROJECT_PACKAGE_LOCK)), before);
  assert.equal((await packages.check()).status, "ready");
});

test("a symlinked workspace root still supports local update, check, and reconcile", async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const alias = `${value.workspace}-alias`;
  await symlink(value.workspace, alias, process.platform === "win32" ? "junction" : "dir");
  context.after(async () => await rm(alias, { force: true }));
  const packages = new ProjectPackageManager({
    workspace: alias,
    projectTrusted: true,
    operationLeaseRoot: value.leaseRoot,
  });
  assert.equal((await packages.update({ all: true })).status, "ready");
  assert.equal((await packages.check()).status, "ready");
  assert.equal((await packages.reconcile()).changed, false);
});

test("v2 package trees reject non-portable names and filesystem-equivalent collisions", {
  skip: process.platform !== "linux",
}, async (context) => {
  const value = await fixture(context);
  await writePackage(value, "1.0.0");
  await writeDeclaration(value);
  const packages = manager(value);
  for (const name of ["CON.txt", "trailing.", "name:stream", "e\u0301.txt"]) {
    const path = join(value.source, name);
    await writeFile(path, "non-portable\n");
    await assert.rejects(packages.update({ all: true }), /not portable/u);
    await rm(path);
  }
  await writeFile(join(value.source, "Case.txt"), "upper\n");
  await writeFile(join(value.source, "case.txt"), "lower\n");
  await assert.rejects(packages.update({ all: true }), /case or Unicode-normalization collision/u);
  await rm(join(value.source, "Case.txt"));
  await rm(join(value.source, "case.txt"));
  await assert.rejects(access(join(value.workspace, PROJECT_PACKAGE_LOCK)), /ENOENT/u);
  await assert.rejects(access(join(value.workspace, PROJECT_PACKAGE_INSTALL_ROOT)), /ENOENT/u);
});

test("normal reload activates only locked project resources and a failed update leaves its live generation intact", async (context) => {
  const value = await fixture(context);
  const agentDir = join(value.workspace, "agent");
  await mkdir(join(value.source, "prompts"));
  await writePackage(value, "1.0.0", `
    export default (api) => {
      api.registerCommand("visible", { handler() {} });
      api.registerCommand("hidden", { handler() {} });
      api.on("session_start", () => {
        api.registerCommand("hidden", { handler() {} });
        api.on("resources_discover", () => ({
          skillPaths: [],
          promptPaths: [
            "prompts/dynamic-visible.md",
            "prompts/dynamic-hidden.md",
            "prompts/!keep.md",
            "prompts/#literal.md"
          ],
          themePaths: []
        }));
      });
    };
  `);
  const manifest = JSON.parse(await readFile(join(value.source, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.rigyn = {
    extensions: ["extensions/index.mjs"],
    prompts: ["prompts/visible.md", "prompts/hidden.md", "prompts/!keep.md", "prompts/#literal.md"],
  };
  await writeFile(join(value.source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(value.source, "prompts", "visible.md"), "Visible prompt\n");
  await writeFile(join(value.source, "prompts", "hidden.md"), "Hidden prompt\n");
  await writeFile(join(value.source, "prompts", "dynamic-visible.md"), "Dynamic visible prompt\n");
  await writeFile(join(value.source, "prompts", "dynamic-hidden.md"), "Dynamic hidden prompt\n");
  await writeFile(join(value.source, "prompts", "!keep.md"), "Literal bang prompt\n");
  await writeFile(join(value.source, "prompts", "#literal.md"), "Literal hash prompt\n");
  await writeDeclaration(value, [
    "command:hidden",
    "prompt:prompts/hidden.md",
    "prompt:prompts/dynamic-hidden.md",
    "prompt:prompts/!keep.md",
    "prompt:prompts/#literal.md",
  ]);
  await manager(value).update({ all: true });

  const settings = SettingsManager.create(value.workspace, agentDir, { projectTrusted: true });
  await settings.reload();
  const loader = new DefaultResourceLoader({
    cwd: value.workspace,
    agentDir,
    settingsManager: settings,
  });
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  await loader.reload();
  const live = getExtensionRuntimeHost(loader.getExtensions().runtime);
  assert.ok(live);
  assert.deepEqual(live.commands().map((entry) => entry.name), ["visible"]);
  await live.dispatch("session_start", { reason: "startup" } as never);
  assert.deepEqual(live.commands().map((entry) => entry.name), ["visible"]);
  await loader.extendResourcesFromExtensions(loader.getExtensions().runtime, "startup");
  assert.deepEqual(loader.getPrompts().prompts.map((entry) => entry.name).sort(), ["dynamic-visible", "visible"]);
  assert.deepEqual(loader.getProjectPackageState().packages.map((entry) => entry.id), ["declared"]);

  await writePackage(value, "2.0.0", `export default () => { throw new Error("replacement activation rejected"); };\n`);
  await assert.rejects(manager(value).update({ all: true }), /replacement activation rejected/u);
  assert.equal(getExtensionRuntimeHost(loader.getExtensions().runtime), live);
  assert.deepEqual(live.commands().map((entry) => entry.name), ["visible"]);
  assert.equal(loader.getProjectPackageState().packages[0]?.version, "1.0.0");
});

test("resource filters are literal, exact, and do not collapse duplicate basenames", async (context) => {
  const value = await fixture(context);
  const agentDir = join(value.workspace, "agent");
  await writePackage(value, "1.0.0");
  await mkdir(join(value.source, "prompts", "a"), { recursive: true });
  await mkdir(join(value.source, "prompts", "b"), { recursive: true });
  for (const [path, body] of [
    ["prompts/[x].md", "literal bracket"],
    ["prompts/x.md", "ordinary x"],
    ["prompts/literalX.md", "glob lookalike"],
    ["prompts/a/same.md", "first basename"],
    ["prompts/b/same.md", "second basename"],
  ] as const) {
    await writeFile(join(value.source, path), `${body}\n`);
  }
  const manifest = JSON.parse(await readFile(join(value.source, "package.json"), "utf8")) as Record<string, unknown>;
  manifest.rigyn = {
    extensions: ["extensions/index.mjs"],
    prompts: [
      "prompts/[x].md",
      "prompts/x.md",
      "prompts/literalX.md",
      "prompts/a/same.md",
      "prompts/b/same.md",
    ],
  };
  await writeFile(join(value.source, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeDeclaration(value, [
    "prompt:prompts/[x].md",
    "prompt:prompts/literal*.md",
    "prompt:prompts/literal?.md",
    "prompt:prompts/a/same.md",
  ]);
  await manager(value).update({ all: true });

  const settings = SettingsManager.create(value.workspace, agentDir, { projectTrusted: true });
  await settings.reload();
  const loader = new DefaultResourceLoader({ cwd: value.workspace, agentDir, settingsManager: settings });
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  await loader.reload();
  assert.deepEqual(loader.getPrompts().prompts.map((entry) => entry.name).sort(), ["literalX", "same", "x"]);
});
