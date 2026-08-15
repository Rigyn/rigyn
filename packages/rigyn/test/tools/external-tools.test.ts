import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  ensureFd,
  findExternalToolBinary,
  getFdArtifact,
  getFdPath,
  promoteExternalToolBinary,
  validateExternalToolArchiveEntries,
  validateExternalToolArchiveIntegrity,
  validateExternalToolArchiveLayout,
} from "../../src/tools/external-tools.js";

test("external tool release pins match the reviewed official target matrix", () => {
  const selected = [
    ["linux", "x64", "fd-v10.4.2-x86_64-unknown-linux-gnu.tar.gz", "def59805cd14b5651b68990855f426ad087f3b96881296d963910431ba3143c8"],
    ["linux", "arm64", "fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz", "6c51f7c5446b3338b1e401ff15dc194c590bb2fa64fd43ff3278300f073adec5"],
    ["darwin", "x64", "fd-v10.3.0-x86_64-apple-darwin.tar.gz", "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3"],
    ["darwin", "arm64", "fd-v10.4.2-aarch64-apple-darwin.tar.gz", "623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a"],
    ["win32", "x64", "fd-v10.4.2-x86_64-pc-windows-msvc.zip", "b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8"],
    ["win32", "arm64", "fd-v10.4.2-aarch64-pc-windows-msvc.zip", "4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92"],
  ] as const;
  for (const [platform, architecture, asset, sha256] of selected) {
    const pin = getFdArtifact(platform, architecture);
    assert.equal(pin?.asset, asset);
    assert.equal(pin?.sha256, sha256);
    assert.equal(pin?.url, `https://github.com/sharkdp/fd/releases/download/${asset.includes("v10.3.0") ? "v10.3.0" : "v10.4.2"}/${asset}`);
    assert.match(pin?.checksumSource ?? "", /^https:\/\/(?:api\.)?github\.com\//u);
  }
  assert.match(getFdArtifact("darwin", "x64")?.notice ?? "", /last upstream-published.*10\.3\.0/iu);
  assert.equal(getFdArtifact("darwin", "arm64")?.notice, undefined);
});

test("external tool integrity verification accepts an exact digest and rejects tampering", () => {
  const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.doesNotThrow(() => validateExternalToolArchiveIntegrity(Buffer.from("abc"), expected));
  assert.throws(
    () => validateExternalToolArchiveIntegrity(Buffer.from("abd"), expected),
    /integrity check failed/u,
  );
});

test("external tool archive preflight rejects hostile names and layouts", () => {
  assert.deepEqual(
    validateExternalToolArchiveEntries(["fixture/", "fixture/fd"]),
    ["fixture/", "fixture/fd"],
  );
  for (const entry of [
    "../fd",
    "/tmp/fd",
    String.raw`C:\Windows\fd.exe`,
    "fixture/../fd",
    `fixture/${"nested/".repeat(64)}fd`,
    `fixture/${"x".repeat(513)}`,
    "fixture/\0fd",
  ]) {
    assert.throws(
      () => validateExternalToolArchiveEntries([entry]),
      /unsafe entry/u,
    );
  }
  assert.throws(
    () => validateExternalToolArchiveEntries(Array.from({ length: 4_097 }, () => "fixture/file")),
    /more than 4096 entries/u,
  );

  validateExternalToolArchiveLayout(["fixture/", "fixture/fd"], "fixture.tar.gz", "fd");
  assert.throws(
    () => validateExternalToolArchiveLayout(["fixture/fd", "outside"], "fixture.tar.gz", "fd"),
    /expected directory layout/u,
  );
  assert.throws(
    () => validateExternalToolArchiveLayout(["fixture/fd", "fixture/fd"], "fixture.tar.gz", "fd"),
    /exactly one expected fd binary/u,
  );
  assert.throws(
    () => validateExternalToolArchiveLayout(["fixture/fd", "fixture/nested/fd"], "fixture.tar.gz", "fd"),
    /exactly one expected fd binary/u,
  );
  assert.throws(
    () => validateExternalToolArchiveLayout(["fixture/readme"], "fixture.tar.gz", "fd"),
    /exactly one expected fd binary/u,
  );
});

test("external tool archive traversal rejects extracted symbolic links", {
  skip: process.platform === "win32" ? "symlink creation is privilege-dependent on Windows" : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-external-tool-symlink-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const extracted = join(root, "extracted");
  const target = join(root, "target");
  await mkdir(extracted);
  await writeFile(target, "binary");
  await symlink(target, join(extracted, "fd"));

  await assert.rejects(
    findExternalToolBinary(extracted, "fd"),
    /symbolic link/u,
  );
});

test("external tool promotion is atomic and preserves an existing destination on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-external-tool-promote-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const destination = join(root, process.platform === "win32" ? "fd.exe" : "fd");
  await writeFile(destination, "existing");
  await assert.rejects(
    promoteExternalToolBinary(join(root, "missing"), destination),
  );
  assert.equal(await readFile(destination, "utf8"), "existing");

  await rm(destination);
  const source = join(root, "staged");
  await writeFile(source, "verified");
  assert.equal(await promoteExternalToolBinary(source, destination), await realpath(destination));
  assert.equal(await readFile(destination, "utf8"), "verified");
});

test("external tool discovery prefers the isolated rigyn bin directory", async (t) => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "rigyn-external-tool-"));
  t.after(async () => await rm(agentDirectory, { recursive: true, force: true }));
  const bin = join(agentDirectory, "bin");
  await mkdir(bin);
  const binary = join(bin, process.platform === "win32" ? "fd.exe" : "fd");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const environment = { RIGYN_HOME: agentDirectory, PATH: "" };
  assert.equal(await getFdPath(environment), binary);
  assert.equal(await ensureFd({ environment, silent: true }), binary);
});

test("external tool discovery never downloads while offline", async (t) => {
  const agentDirectory = await mkdtemp(join(tmpdir(), "rigyn-external-tool-offline-"));
  t.after(async () => await rm(agentDirectory, { recursive: true, force: true }));
  assert.equal(await ensureFd({
    environment: { RIGYN_HOME: agentDirectory, RIGYN_OFFLINE: "yes", PATH: "" },
    silent: true,
  }), undefined);
});

test("fd discovery falls back to executable PATH entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-external-tool-path-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const pathDirectory = join(root, "path");
  await mkdir(pathDirectory);
  const binary = join(pathDirectory, process.platform === "win32" ? "fd.exe" : "fd");
  await writeFile(binary, process.platform === "win32" ? "" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") await chmod(binary, 0o755);

  assert.equal(await getFdPath({
    RIGYN_HOME: join(root, "agent"),
    PATH: [pathDirectory, join(root, "missing")].join(delimiter),
  }), await realpath(binary));
});

test("coalesced install failures honor each caller's warning preference", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-external-tool-inflight-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });
  let fetchCalls = 0;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await fetchGate;
    return new Response("unavailable", { status: 503 });
  };
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  const environment = { RIGYN_HOME: join(root, "agent"), PATH: "" };

  const silent = ensureFd({ environment, silent: true });
  while (fetchCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  const loud = ensureFd({ environment });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  releaseFetch();

  assert.deepEqual(await Promise.all([silent, loud]), [undefined, undefined]);
  assert.equal(fetchCalls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Could not install fd.*HTTP 503/u);
});

test("install coalescing does not cross isolated agent directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-external-tool-scopes-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await fetchGate;
    return new Response("unavailable", { status: 503 });
  };

  const first = ensureFd({
    environment: { RIGYN_HOME: join(root, "first"), PATH: "" },
    silent: true,
  });
  const second = ensureFd({
    environment: { RIGYN_HOME: join(root, "second"), PATH: "" },
    silent: true,
  });
  while (fetchCalls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  releaseFetch();

  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  assert.equal(fetchCalls, 2);
});

test("external tool downloads use a pinned artifact and reject an integrity mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-external-tool-integrity-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response("not the reviewed archive");
  };
  const warnings: string[] = [];
  console.warn = (message?: unknown) => { warnings.push(String(message)); };

  assert.equal(await ensureFd({
    environment: { RIGYN_HOME: join(root, "agent"), PATH: "" },
  }), undefined);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!, /\/releases\/download\/v10\.4\.2\//u);
  assert.match(warnings[0] ?? "", /integrity check failed/iu);
  assert.deepEqual(await readdir(join(root, "agent", "bin")), []);
});

test("external tool downloads reject declared bodies above the archive limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-external-tool-size-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });
  globalThis.fetch = async () => new Response("small", {
    headers: { "content-length": String(128 * 1024 * 1024) },
  });
  const warnings: string[] = [];
  console.warn = (message?: unknown) => { warnings.push(String(message)); };

  assert.equal(await ensureFd({
    environment: { RIGYN_HOME: join(root, "agent"), PATH: "" },
  }), undefined);
  assert.match(warnings[0] ?? "", /archive exceeds/iu);
});
