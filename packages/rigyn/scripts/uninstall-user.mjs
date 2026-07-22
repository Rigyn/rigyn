import { writeFileSync } from "node:fs";
import { lstat, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  UNINSTALL_RECORD_SUFFIX,
  assertNoOtherActiveRuntimes,
  assertOwnedLaunchers,
  assertProtectedInstallRoot,
  createUninstallRecord,
  exists,
  installationPaths,
  readInstallationMarker,
  recoverInterruptedUninstall,
  withLifecycleLock,
  writeFileAtomically,
} from "./lifecycle-common.mjs";

const installRoot = resolve(process.env.RIGYN_INSTALL_DIR ?? join(homedir(), ".rigyn"));
const paths = installationPaths(installRoot);

if (!process.argv.slice(2).includes("--yes")) {
  throw new Error(`Refusing to remove ${installRoot} without --yes`);
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

    const commandContents = await readFile(paths.command, "utf8");
    const record = createUninstallRecord(installRoot, markerRecord.contents, commandContents);
    const recordPath = `${installRoot}${UNINSTALL_RECORD_SUFFIX}`;
    await writeFileAtomically(recordPath, `${JSON.stringify(record, null, 2)}\n`, 0o600);
    await rename(installRoot, record.tombstone);
    if (process.platform !== "win32") await rm(paths.command, { force: true });
    await rm(record.tombstone, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(recordPath, { force: true });
    writeFileSync(1, `Removed the self-contained rigyn installation at ${installRoot}\n`);
  });
}

await uninstall();
