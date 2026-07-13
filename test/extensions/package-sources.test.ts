import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test, { type TestContext } from "node:test";

import {
  LocalExtensionPackageManager,
  discoverExtensions,
  parseExtensionPackageSource,
  renderExtensionPrompt,
} from "../../src/extensions/index.js";
import { sha256 } from "../../src/tools/hash.js";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-package-sources-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

async function command(commandValue: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const child = spawn(commandValue, [...args], {
    cwd,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (value: Buffer) => stdout.push(value));
  child.stderr.on("data", (value: Buffer) => stderr.push(value));
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(`${commandValue} failed (${result.code ?? result.signal}): ${Buffer.concat(stderr).toString("utf8")}`);
  }
  return Buffer.concat(stdout).toString("utf8").trim();
}

async function writeExtension(root: string, options: { id?: string; version: string; word: string; marker?: string }): Promise<void> {
  await mkdir(join(root, "prompts"), { recursive: true });
  await writeFile(join(root, "extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: options.id ?? "remote-reference",
    name: "Remote reference",
    version: options.version,
    contributions: {
      prompts: [{ id: "remote-reference", path: "prompts/reference.md" }],
    },
  }, null, 2)}\n`);
  await writeFile(join(root, "prompts", "reference.md"), `${options.word} {{input}}\n`);
  if (options.marker !== undefined) {
    const script = `node -e "require('node:fs').writeFileSync(${JSON.stringify(options.marker)}, 'ran')"`;
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "rigyn-remote-reference",
      version: options.version,
      scripts: { preinstall: script, install: script, postinstall: script, prepack: script, prepare: script, postpack: script },
    }, null, 2)}\n`);
  }
}

async function npmInvocation(): Promise<{ command: string; prefix: string[] }> {
  if (process.platform !== "win32") return { command: "npm", prefix: [] };
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined) throw new Error("npm_execpath is required for npm package tests on Windows");
  return { command: process.execPath, prefix: [npmExecPath] };
}

async function packNpmFixture(root: string, fixture: string): Promise<string> {
  const destination = join(root, `tarballs-${basename(fixture)}`);
  await mkdir(destination);
  const npm = await npmInvocation();
  await command(npm.command, [
    ...npm.prefix,
    "pack",
    "--ignore-scripts=true",
    "--json=false",
    "--silent",
    "--pack-destination",
    destination,
    "--",
    fixture,
  ], root, {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  });
  const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  return join(destination, archives[0]!);
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarEntry(name: string, type: "0" | "2" | "5", content = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, content.length);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
  return Buffer.concat([header, content, padding]);
}

function maliciousArchive(path: string, type: "0" | "2" = "0"): Buffer {
  return gzipSync(Buffer.concat([
    tarEntry(path, type, type === "0" ? Buffer.from("bad") : Buffer.alloc(0)),
    Buffer.alloc(1024),
  ]));
}

function archive(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

test("package source parser accepts bounded npm and Git forms and rejects unsafe protocols", () => {
  assert.deepEqual(parseExtensionPackageSource("npm:plain@^1.2.0"), {
    kind: "npm",
    source: "npm:plain@^1.2.0",
    specifier: "plain@^1.2.0",
  });
  assert.deepEqual(parseExtensionPackageSource("npm:@scope/name@latest"), {
    kind: "npm",
    source: "npm:@scope/name@latest",
    specifier: "@scope/name@latest",
  });
  assert.deepEqual(parseExtensionPackageSource("https://example.com/owner/repo.git#main"), {
    kind: "git",
    source: "git:https://example.com/owner/repo.git#main",
    repository: "https://example.com/owner/repo.git",
    ref: "main",
  });
  assert.throws(() => parseExtensionPackageSource("http://example.com/repo.git"), /Unsupported|HTTPS/u);
  assert.throws(() => parseExtensionPackageSource("https://user:secret@example.com/repo.git"), /credential-free/u);
  assert.throws(() => parseExtensionPackageSource("https://example.com/repo.git?token=secret"), /query/u);
  assert.deepEqual(parseExtensionPackageSource("git:ssh://git@example.com/owner/repo.git@v1"), {
    kind: "git",
    source: "git:ssh://git@example.com/owner/repo.git#v1",
    repository: "ssh://git@example.com/owner/repo.git",
    ref: "v1",
  });
  assert.deepEqual(parseExtensionPackageSource("git:git@example.com:owner/repo.git#main"), {
    kind: "git",
    source: "git:git@example.com:owner/repo.git#main",
    repository: "git@example.com:owner/repo.git",
    ref: "main",
  });
  assert.deepEqual(parseExtensionPackageSource("git:example.com/owner/repo.git@main"), {
    kind: "git",
    source: "git:https://example.com/owner/repo.git#main",
    repository: "https://example.com/owner/repo.git",
    ref: "main",
  });
  assert.throws(() => parseExtensionPackageSource("git:https://example.com/repo.git#../bad"), /ref/u);
  assert.throws(() => parseExtensionPackageSource("npm:plain@npm:other"), /selector/u);
  assert.throws(() => parseExtensionPackageSource("npm:plain@$(id)"), /selector/u);
  assert.throws(() => parseExtensionPackageSource("npm:https://example.com/package.tgz"), /name/u);
  assert.throws(() => parseExtensionPackageSource("npm:--option"), /invalid/u);
});

test("npm sources install and update atomically while source-package scripts stay disabled", async (t) => {
  const root = await temporary(t);
  const marker = join(root, "lifecycle-ran");
  const firstSource = join(root, "npm-v1");
  const secondSource = join(root, "npm-v2");
  const badSource = join(root, "npm-bad");
  await mkdir(firstSource);
  await mkdir(secondSource);
  await mkdir(badSource);
  await writeExtension(firstSource, { version: "1.0.0", word: "first", marker });
  await writeExtension(secondSource, { version: "2.0.0", word: "second", marker });
  await writeExtension(badSource, { id: "different-package", version: "3.0.0", word: "bad", marker });
  const firstArchive = await packNpmFixture(root, firstSource);
  const secondArchive = await packNpmFixture(root, secondSource);
  const badArchive = await packNpmFixture(root, badSource);
  await assert.rejects(access(marker), /ENOENT/u);

  const map = join(root, "npm-map.json");
  const capture = join(root, "npm-argv.jsonl");
  await writeFile(map, JSON.stringify({
    "remote-reference@1||2": firstArchive,
    "remote-reference@2": secondArchive,
    "remote-reference@3": badArchive,
  }));
  const fakeNpm = join(root, "fake-npm.mjs");
  await writeFile(fakeNpm, `
import { appendFile, copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
const [mapPath, capturePath, ...args] = process.argv.slice(2);
await appendFile(capturePath, JSON.stringify(args) + "\\n");
const sources = JSON.parse(await readFile(mapPath, "utf8"));
const specifier = args.at(-1);
const destination = args[args.indexOf("--pack-destination") + 1];
if (typeof sources[specifier] !== "string" || typeof destination !== "string") process.exit(2);
await copyFile(sources[specifier], join(destination, "package.tgz"));
`);
  const packages = new LocalExtensionPackageManager(
    { user: join(root, "installed") },
    {},
    { npm: { command: process.execPath, prefix: [fakeNpm, map, capture] } },
  );

  const local = await packages.install(`npm:${pathToFileURL(firstArchive).href}`);
  assert.equal(local.provenance.kind, "npm");
  assert.equal(local.provenance.source, `npm:${pathToFileURL(firstArchive).href}`);
  assert.equal(local.provenance.resolvedVersion, "1.0.0");
  assert.equal(local.provenance.archiveSha256, sha256(await readFile(firstArchive)));
  await packages.remove("remote-reference");

  const installed = await packages.install("npm:remote-reference@1||2", "user", { allowScripts: true });
  assert.equal(installed.version, "1.0.0");
  assert.equal(installed.provenance.kind, "npm");
  assert.equal(installed.provenance.packageName, "rigyn-remote-reference");
  assert.equal(installed.provenance.source, "npm:remote-reference@1||2");
  const updated = await packages.update("remote-reference", "user", "npm:remote-reference@2");
  assert.equal(updated.version, "2.0.0");
  assert.equal(updated.provenance.kind, "npm");
  assert.equal(updated.provenance.resolvedVersion, "2.0.0");
  assert.equal(updated.provenance.installedAt, installed.provenance.installedAt);
  assert.ok(updated.provenance.updatedAt);
  const repeated = await packages.update("remote-reference");
  assert.equal(repeated.provenance.kind, "npm");
  assert.equal(repeated.provenance.source, "npm:remote-reference@2");
  await assert.rejects(packages.update("remote-reference", "user", "npm:remote-reference@3"), /expected remote-reference/u);
  assert.equal((await packages.list())[0]?.version, "2.0.0");
  const catalog = await discoverExtensions(packages.sources(true));
  assert.equal(renderExtensionPrompt(catalog.prompt("remote-reference")!, "ok"), "second ok\n");
  await assert.rejects(access(marker), /ENOENT/u);
  const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.ok(calls.every((args) => args.includes("--ignore-scripts=true")));
  assert.ok(calls.every((args) => args.includes("--") && args[args.length - 1]?.startsWith("remote-reference@")));
  await packages.remove("remote-reference");
  assert.deepEqual(await packages.list(), []);
});

test("npm archive traversal, links, checksum corruption, and command output overflow fail closed", async (t) => {
  const root = await temporary(t);
  const installed = join(root, "installed");
  const traversal = join(root, "traversal.tgz");
  const link = join(root, "link.tgz");
  const checksum = join(root, "checksum.tgz");
  const padding = join(root, "padding.tgz");
  const collision = join(root, "collision.tgz");
  const reserved = join(root, "reserved.tgz");
  await writeFile(traversal, maliciousArchive("package/../escape"));
  await writeFile(link, maliciousArchive("package/link", "2"));
  const corrupt = tarEntry("package/file", "0", Buffer.from("bad"));
  corrupt[20] = (corrupt[20] ?? 0) ^ 0xff;
  await writeFile(checksum, archive([corrupt]));
  const nonzeroPadding = tarEntry("package/file", "0", Buffer.from("x"));
  nonzeroPadding[513] = 1;
  await writeFile(padding, archive([nonzeroPadding]));
  await writeFile(collision, archive([
    tarEntry("package/Foo/a", "0", Buffer.from("a")),
    tarEntry("package/foo/b", "0", Buffer.from("b")),
  ]));
  await writeFile(reserved, maliciousArchive("package/CON"));
  const packages = new LocalExtensionPackageManager({ user: installed });
  await assert.rejects(packages.install(`npm:${pathToFileURL(traversal).href}`), /unsafe path/u);
  await assert.rejects(packages.install(`npm:${pathToFileURL(link).href}`), /unsupported tar entry type/u);
  await assert.rejects(packages.install(`npm:${pathToFileURL(checksum).href}`), /checksum/u);
  await assert.rejects(packages.install(`npm:${pathToFileURL(padding).href}`), /padding/u);
  await assert.rejects(packages.install(`npm:${pathToFileURL(collision).href}`), /collision/u);
  await assert.rejects(packages.install(`npm:${pathToFileURL(reserved).href}`), /unsafe path/u);
  assert.deepEqual(await packages.list(), []);

  const spam = join(root, "spam.mjs");
  await writeFile(spam, `process.stdout.write("x".repeat(4096));\n`);
  const noisy = new LocalExtensionPackageManager(
    { user: installed },
    { maxCommandOutputBytes: 128 },
    { npm: { command: process.execPath, prefix: [spam] } },
  );
  await assert.rejects(noisy.install("npm:remote-reference@1"), /output exceeded/u);
  assert.deepEqual(await noisy.list(), []);
});

async function gitCommit(repository: string, message: string): Promise<string> {
  const common = [
    "-c", "user.name=Rigyn Test",
    "-c", "user.email=harness@example.invalid",
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=",
  ];
  await command("git", ["-C", repository, ...common, "add", "-A"], repository);
  await command("git", ["-C", repository, ...common, "commit", "--quiet", "-m", message], repository, {
    ...process.env,
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  });
  return await command("git", ["-C", repository, "rev-parse", "HEAD"], repository);
}

test("local Git source records revisions, updates atomically, excludes VCS data, and never runs scripts", async (t) => {
  const root = await temporary(t);
  const repository = join(root, "repository");
  const marker = join(root, "git-lifecycle-ran");
  await mkdir(repository);
  await command("git", ["init", "--quiet", "--initial-branch=main", repository], root);
  await writeExtension(repository, { version: "1.0.0", word: "git-first", marker });
  const firstRevision = await gitCommit(repository, "first");
  const source = `git:${pathToFileURL(repository).href}#main`;
  const packages = new LocalExtensionPackageManager({ user: join(root, "installed") });
  const installed = await packages.install(source);
  assert.equal(installed.version, "1.0.0");
  assert.equal(installed.provenance.kind, "git");
  assert.equal(installed.provenance.revision, firstRevision);
  assert.equal(installed.provenance.source, source);
  await assert.rejects(access(join(installed.packageRoot, ".git")), /ENOENT/u);
  await assert.rejects(access(marker), /ENOENT/u);

  await writeExtension(repository, { version: "2.0.0", word: "git-second", marker });
  const secondRevision = await gitCommit(repository, "second");
  const updated = await packages.update("remote-reference");
  assert.equal(updated.version, "2.0.0");
  assert.equal(updated.provenance.kind, "git");
  assert.equal(updated.provenance.revision, secondRevision);
  assert.notEqual(updated.provenance.revision, firstRevision);
  assert.equal(updated.provenance.installedAt, installed.provenance.installedAt);

  await writeExtension(repository, { id: "different-package", version: "3.0.0", word: "bad", marker });
  await gitCommit(repository, "bad");
  await assert.rejects(packages.update("remote-reference"), /expected remote-reference/u);
  assert.equal((await packages.list())[0]?.version, "2.0.0");
  const catalog = await discoverExtensions(packages.sources(true));
  assert.equal(renderExtensionPrompt(catalog.prompt("remote-reference")!, "ok"), "git-second ok\n");
  await assert.rejects(access(marker), /ENOENT/u);
  await packages.remove("remote-reference");
  assert.deepEqual(await packages.list(), []);
});

test("SSH Git packages use non-interactive agent authentication and preserve pinned source provenance", async (t) => {
  const root = await temporary(t);
  const capture = join(root, "git-calls.jsonl");
  const fakeGit = join(root, "fake-git.mjs");
  const revision = "d".repeat(40);
  await writeFile(fakeGit, `
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [capture, ...args] = process.argv.slice(2);
await appendFile(capture, JSON.stringify({
  args,
  home: process.env.HOME,
  agent: process.env.SSH_AUTH_SOCK,
  prompt: process.env.GIT_TERMINAL_PROMPT,
  ssh: process.env.GIT_SSH_COMMAND,
}) + "\\n");
if (args.includes("clone")) {
  const destination = args.at(-1);
  await mkdir(join(destination, "prompts"), { recursive: true });
  await writeFile(join(destination, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "ssh-reference",
    name: "SSH reference",
    contributions: { prompts: [{ id: "ssh-reference", path: "prompts/reference.md" }] },
  }));
  await writeFile(join(destination, "prompts", "reference.md"), "ssh {{input}}\\n");
}
if (args.includes("rev-parse")) process.stdout.write(${JSON.stringify(revision)} + "\\n");
`);
  const previousAgent = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = join(root, "agent.sock");
  try {
    const manager = new LocalExtensionPackageManager(
      { user: join(root, "installed") },
      {},
      { git: { command: process.execPath, prefix: [fakeGit, capture] } },
    );
    const installed = await manager.install("git:git@example.com:owner/repo.git#main");
    assert.equal(installed.provenance.kind, "git");
    assert.equal(installed.provenance.source, "git:git@example.com:owner/repo.git#main");
    assert.equal(installed.provenance.revision, revision);
    const pinnedManager = new LocalExtensionPackageManager(
      { user: join(root, "pinned-installed") },
      {},
      { git: { command: process.execPath, prefix: [fakeGit, capture] } },
    );
    const pinned = await pinnedManager.install(`ssh://git@example.com/owner/repo.git#${revision}`);
    assert.equal(pinned.provenance.kind, "git");
    assert.equal(pinned.provenance.source, `git:ssh://git@example.com/owner/repo.git#${revision}`);
  } finally {
    if (previousAgent === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previousAgent;
  }

  const calls = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    args: string[];
    home: string;
    agent: string;
    prompt: string;
    ssh: string;
  });
  const clone = calls.find((entry) => entry.args.includes("clone"));
  assert.ok(clone);
  assert.equal(clone.agent, join(root, "agent.sock"));
  assert.equal(clone.prompt, "0");
  assert.equal(clone.ssh, "ssh -oBatchMode=yes");
  assert.ok(clone.args.includes("protocol.ssh.allow=always"));
  assert.notEqual(clone.home, join(root, "installed"));
  assert.ok(calls.some((entry) => entry.args.includes("fetch") && entry.args.includes(revision)));
  assert.ok(calls.some((entry) => entry.args.includes("checkout") && entry.args.includes(revision)));
});
