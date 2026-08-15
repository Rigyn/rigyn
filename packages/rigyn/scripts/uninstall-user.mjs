import { writeFileSync } from "node:fs";
import { lstat, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  UNINSTALL_RECORD_SUFFIX,
  assertNoOtherActiveRuntimes,
  assertOwnedLaunchers,
  assertProtectedInstallRoot,
  createUninstallRecord,
  exists,
  installationPaths,
  prepareManagedCredentialPurge,
  purgeManagedToolOutput,
  readInstallationMarker,
  recoverInterruptedUninstall,
  removeOwnedPosixCommand,
  withCredentialPurgeDisposal,
  withLifecycleLock,
  writeFileAtomically,
} from "./lifecycle-common.mjs";

const installRoot = resolve(process.env.RIGYN_INSTALL_DIR ?? join(homedir(), ".rigyn"));
const paths = installationPaths(installRoot);
const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);

if (invokedPath === fileURLToPath(import.meta.url) && !process.argv.slice(2).includes("--yes")) {
  throw new Error(`Refusing to remove ${installRoot} without --yes`);
}

export async function removeCommandAfterIsolation({
  command,
  commandSha256,
  installRoot: selectedInstallRoot,
  recordPath,
  tombstone,
}) {
  try {
    await removeOwnedPosixCommand(command, commandSha256);
  } catch (error) {
    try {
      await rename(tombstone, selectedInstallRoot);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "rigyn uninstall failed and rollback was incomplete",
      );
    }
    try {
      await rm(recordPath, { force: true });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "rigyn uninstall failed and rollback was incomplete",
      );
    }
    throw error;
  }
}

export async function commitSourceUninstall({
  installRoot: selectedInstallRoot,
  platform = process.platform,
  purgeCredentials,
  record,
  recordPath,
}) {
  return await withCredentialPurgeDisposal(purgeCredentials, async () => {
    await writeFileAtomically(recordPath, `${JSON.stringify(record, null, 2)}\n`, 0o600);
    await rename(selectedInstallRoot, record.tombstone);
    if (platform !== "win32") {
      await removeCommandAfterIsolation({
        command: record.commandLink,
        commandSha256: record.commandSha256,
        installRoot: selectedInstallRoot,
        recordPath,
        tombstone: record.tombstone,
      });
    }
    await purgeCredentials();
    await rm(record.tombstone, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(recordPath, { force: true });
  });
}

async function uninstall() {
  await assertProtectedInstallRoot(installRoot, { callerCwd: process.cwd() });
  await withLifecycleLock(installRoot, async () => {
    const recovered = await recoverInterruptedUninstall(installRoot);
    if (recovered && !(await exists(installRoot))) {
      writeFileSync(1, `Removed the self-contained rigyn installation at ${installRoot}\n`);
      return;
    }
    if (!(await exists(installRoot))) {
      writeFileSync(1, `rigyn is not installed at ${installRoot}\n`);
      return;
    }
    const rootMetadata = await lstat(installRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error(`Install path must be a real directory: ${installRoot}`);
    }
    const markerRecord = await readInstallationMarker(installRoot);
    if (markerRecord === undefined) throw new Error(`Refusing to remove an unrecognized installation: ${installRoot}`);
    await assertOwnedLaunchers(installRoot, markerRecord.marker);
    await assertNoOtherActiveRuntimes(installRoot, markerRecord.marker);
    await purgeManagedToolOutput({ installRoot });
    const commandContents = await readFile(paths.command, "utf8");
    const record = createUninstallRecord(installRoot, markerRecord.contents, commandContents);
    const recordPath = `${installRoot}${UNINSTALL_RECORD_SUFFIX}`;
    const purgeCredentials = await prepareManagedCredentialPurge(installRoot);
    await commitSourceUninstall({
      installRoot,
      purgeCredentials,
      record,
      recordPath,
    });
    writeFileSync(1, `Removed the self-contained rigyn installation at ${installRoot}\n`);
  });
}

if (invokedPath === fileURLToPath(import.meta.url)) await uninstall();
