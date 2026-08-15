import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const MAX_HELPER_BYTES = 16 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const require = createRequire(import.meta.url);

export function macosKeychainHelperPath(arch = process.arch): string {
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`macOS Keychain helper is unavailable for ${arch}`);
  }
  const packagePath = require.resolve("@rigyn/terminal/package.json");
  return join(dirname(packagePath), "native", "darwin", "prebuilds", `darwin-${arch}`, "rigyn-keychain-helper");
}

export function assertMacosKeychainHelperPath(path: string): void {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("macOS Keychain helper path must be absolute");
}

export async function retainMacosKeychainHelper(
  path = macosKeychainHelperPath(),
): Promise<{ path: string; release(): Promise<void> }> {
  assertMacosKeychainHelperPath(path);
  const selected = await lstat(path);
  if (!selected.isFile() || selected.isSymbolicLink() || selected.size > MAX_HELPER_BYTES) {
    throw new Error("macOS Keychain helper must be a bounded regular file");
  }
  const directory = await mkdtemp(join(tmpdir(), "rigyn-keychain-helper-"));
  const target = join(directory, "rigyn-keychain-helper");
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await chmod(directory, 0o700);
    source = await open(path, constants.O_RDONLY | NO_FOLLOW);
    const information = await source.stat();
    if (
      !information.isFile()
      || information.dev !== selected.dev
      || information.ino !== selected.ino
      || information.size !== selected.size
      || information.size > MAX_HELPER_BYTES
    ) {
      throw new Error("macOS Keychain helper changed while it was being retained");
    }
    const bytes = await source.readFile();
    if (bytes.byteLength !== information.size) {
      throw new Error("macOS Keychain helper changed while it was being retained");
    }
    destination = await open(target, "wx", 0o700);
    await destination.writeFile(bytes);
    await destination.sync();
    await destination.chmod(0o700);
    return {
      path: target,
      async release(): Promise<void> {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
}
