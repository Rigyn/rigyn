import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { appendFile, link, mkdtemp, rm, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readTrustedFileSync,
  TrustedResourceFileChangedError,
  TrustedResourceFileLimitError,
} from "../../src/core/resource-file.js";

test("trusted resource snapshots accept the exact limit and reject max plus one", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-resource-snapshot-limit-"));
  const path = join(root, "resource.txt");
  await writeFile(path, "x".repeat(64));
  assert.equal(readTrustedFileSync(path, 64, "Fixture").byteLength, 64);

  await appendFile(path, "x");
  assert.throws(
    () => readTrustedFileSync(path, 64, "Fixture"),
    (error) => error instanceof TrustedResourceFileLimitError && /Fixture exceeds 64 bytes/u.test(error.message),
  );
});

test("trusted resource snapshots reject replacement and growth after a lexical check", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-resource-snapshot-race-"));
  const path = join(root, "resource.txt");
  const prior = join(root, "prior.txt");
  await writeFile(path, "original");
  const replacementSnapshot = lstatSync(path);
  await rename(path, prior);
  await writeFile(path, "replaced");
  assert.throws(
    () => readTrustedFileSync(path, 64, "Fixture", { expectedInformation: replacementSnapshot }),
    TrustedResourceFileChangedError,
  );

  const growthSnapshot = lstatSync(path);
  await appendFile(path, "-growth");
  assert.throws(
    () => readTrustedFileSync(path, 64, "Fixture", { expectedInformation: growthSnapshot }),
    TrustedResourceFileChangedError,
  );
});

test("trusted resource snapshots preserve explicit symlink policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-resource-snapshot-link-"));
  const source = join(root, "source.txt");
  const linkPath = join(root, "link.txt");
  await writeFile(source, "linked");
  await symlink(source, linkPath);

  assert.equal(readTrustedFileSync(linkPath, 64, "Fixture").toString("utf8"), "linked");
  assert.throws(
    () => readTrustedFileSync(linkPath, 64, "Fixture", { rejectSymbolicLink: true }),
    /Fixture is not a regular file/u,
  );

  const replaced = join(root, "replaced.txt");
  await link(source, replaced);
  const expectedInformation = lstatSync(replaced);
  await rm(replaced);
  await symlink(source, replaced);
  assert.throws(
    () => readTrustedFileSync(replaced, 64, "Fixture", { expectedInformation, rejectSymbolicLink: true }),
    TrustedResourceFileChangedError,
  );
});
