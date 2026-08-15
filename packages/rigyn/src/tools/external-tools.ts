import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { getAgentDir } from "../config/paths.js";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_096;
const MAX_ARCHIVE_DEPTH = 64;
const MAX_ENTRY_BYTES = 512;
const inflight = new Map<string, Promise<string>>();
const executeFile = promisify(execFile);

export interface ExternalToolArtifact {
  asset: string;
  url: string;
  sha256: string;
  checksumSource: string;
  notice?: string;
}

interface ReleasePin {
  readonly assets: Readonly<Record<string, {
    url: string;
    sha256: string;
    checksumSource: string;
    notice?: string;
  }>>;
}

const FD_RELEASE_PIN: ReleasePin = {
    assets: {
      "fd-v10.4.2-aarch64-apple-darwin.tar.gz": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-aarch64-apple-darwin.tar.gz",
        sha256: "623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a",
        checksumSource: "https://api.github.com/repos/sharkdp/fd/releases/tags/v10.4.2",
      },
      "fd-v10.4.2-aarch64-pc-windows-msvc.zip": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-aarch64-pc-windows-msvc.zip",
        sha256: "4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92",
        checksumSource: "https://api.github.com/repos/sharkdp/fd/releases/tags/v10.4.2",
      },
      "fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-aarch64-unknown-linux-gnu.tar.gz",
        sha256: "6c51f7c5446b3338b1e401ff15dc194c590bb2fa64fd43ff3278300f073adec5",
        checksumSource: "https://api.github.com/repos/sharkdp/fd/releases/tags/v10.4.2",
      },
      "fd-v10.3.0-x86_64-apple-darwin.tar.gz": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-x86_64-apple-darwin.tar.gz",
        sha256: "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
        checksumSource: "https://api.github.com/repos/sharkdp/fd/releases/tags/v10.3.0",
        notice: "fd 10.4.2 has no official Intel macOS archive; using the last upstream-published Intel macOS artifact, fd 10.3.0",
      },
      "fd-v10.4.2-x86_64-pc-windows-msvc.zip": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-x86_64-pc-windows-msvc.zip",
        sha256: "b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8",
        checksumSource: "https://api.github.com/repos/sharkdp/fd/releases/tags/v10.4.2",
      },
      "fd-v10.4.2-x86_64-unknown-linux-gnu.tar.gz": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-x86_64-unknown-linux-gnu.tar.gz",
        sha256: "def59805cd14b5651b68990855f426ad087f3b96881296d963910431ba3143c8",
        checksumSource: "https://api.github.com/repos/sharkdp/fd/releases/tags/v10.4.2",
      },
    },
};

function fdBinaryName(operatingSystem = process.platform): string {
  return `fd${operatingSystem === "win32" ? ".exe" : ""}`;
}

export function getFdArtifact(
  operatingSystem: NodeJS.Platform = process.platform,
  machineArchitecture: string = process.arch,
): ExternalToolArtifact | undefined {
  const architecture = machineArchitecture === "x64"
    ? "x86_64"
    : machineArchitecture === "arm64"
      ? "aarch64"
      : undefined;
  if (architecture === undefined) return undefined;
  const version = operatingSystem === "darwin" && architecture === "x86_64" ? "10.3.0" : "10.4.2";
  const target = operatingSystem === "linux"
    ? `${architecture}-unknown-linux-gnu`
    : operatingSystem === "darwin"
      ? `${architecture}-apple-darwin`
      : operatingSystem === "win32"
        ? `${architecture}-pc-windows-msvc`
        : undefined;
  if (target === undefined) return undefined;
  const extension = operatingSystem === "win32" ? "zip" : "tar.gz";
  const asset = `fd-v${version}-${target}.${extension}`;
  const pin = FD_RELEASE_PIN.assets[asset];
  if (pin === undefined) return undefined;
  return {
    asset,
    url: pin.url,
    sha256: pin.sha256,
    checksumSource: pin.checksumSource,
    ...(pin.notice === undefined ? {} : { notice: pin.notice }),
  };
}

async function executable(path: string, operatingSystem = process.platform): Promise<string | undefined> {
  try {
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink()) return undefined;
    if (operatingSystem !== "win32") await access(path, constants.X_OK);
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export async function getFdPath(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const isolated = join(getAgentDir(environment), "bin", fdBinaryName());
  const installed = await executable(isolated);
  if (installed !== undefined) return installed;
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const found = await executable(join(directory, fdBinaryName()));
    if (found !== undefined) return found;
  }
  return undefined;
}

function unsafeEntry(entry: string): never {
  throw new Error(`Archive contains an unsafe entry: ${entry}`);
}

export function validateExternalToolArchiveEntries(entries: readonly string[]): string[] {
  if (!Array.isArray(entries) || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`);
  }
  const validated: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry === ""
      || Buffer.byteLength(entry, "utf8") > MAX_ENTRY_BYTES
      || /[\0\r\n]/u.test(entry)
      || entry.startsWith("/")
      || /^[a-z]:[\\/]/iu.test(entry)
      || entry.includes("\\")) unsafeEntry(String(entry));
    const withoutTrailingSlash = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const segments = withoutTrailingSlash.split("/");
    if (segments.length === 0 || segments.length > MAX_ARCHIVE_DEPTH
      || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      unsafeEntry(entry);
    }
    validated.push(entry);
  }
  return validated;
}

function archiveRoot(asset: string): string {
  return basename(asset)
    .replace(/\.tar\.(?:gz|xz)$/u, "")
    .replace(/\.(?:tgz|zip)$/u, "");
}

export function validateExternalToolArchiveLayout(
  entries: readonly string[],
  asset: string,
  binary: string,
): void {
  const selected = validateExternalToolArchiveEntries(entries);
  const root = archiveRoot(asset);
  if (root === "" || selected.some((entry) => entry !== root && entry !== `${root}/` && !entry.startsWith(`${root}/`))) {
    throw new Error("Archive does not use the expected directory layout");
  }
  const expected = new Set([binary, `${binary}.exe`]);
  const binaries = selected.filter((entry) => {
    if (entry.endsWith("/")) return false;
    return expected.has(basename(entry));
  });
  if (binaries.length !== 1) {
    throw new Error(`Archive must contain exactly one expected ${binary} binary`);
  }
}

export async function findExternalToolBinary(directory: string, name: string): Promise<string | undefined> {
  const root = resolve(directory);
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const matches: string[] = [];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > MAX_ARCHIVE_DEPTH) throw new Error("Extracted archive is too deeply nested");
    for (const entry of await readdir(current.directory)) {
      visited += 1;
      if (visited > MAX_ARCHIVE_ENTRIES) throw new Error("Extracted archive contains too many entries");
      const path = join(current.directory, entry);
      const information = await lstat(path);
      if (information.isSymbolicLink()) throw new Error("Extracted archive contains a symbolic link");
      if (information.isDirectory()) {
        pending.push({ directory: path, depth: current.depth + 1 });
        continue;
      }
      if (!information.isFile()) throw new Error("Extracted archive contains a non-regular file");
      if (entry === name || entry === `${name}.exe`) matches.push(path);
    }
  }
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new Error(`Extracted archive contains multiple ${name} binaries`);
  const selected = await realpath(matches[0]!);
  const local = relative(root, selected);
  if (local === ".." || local.startsWith(`..${sep}`) || resolve(selected) === root) {
    throw new Error("Extracted binary escapes the archive directory");
  }
  return selected;
}

export async function promoteExternalToolBinary(
  source: string,
  destination: string,
  operatingSystem: NodeJS.Platform = process.platform,
): Promise<string> {
  const information = await lstat(source);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("External tool source must be a regular file");
  }
  const parent = dirname(resolve(destination));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staged = join(parent, `.rigyn-tool-${randomUUID()}`);
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    if (operatingSystem !== "win32") await chmod(staged, 0o755);
    await rename(staged, destination);
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
  return await realpath(destination);
}

function offline(environment: NodeJS.ProcessEnv): boolean {
  return /^(?:1|true|yes|on)$/iu.test(environment.RIGYN_OFFLINE ?? "");
}

async function responseBytes(response: Response): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_BYTES) {
      throw new Error(`archive exceeds the ${MAX_ARCHIVE_BYTES} byte limit`);
    }
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) throw new Error(`archive exceeds the ${MAX_ARCHIVE_BYTES} byte limit`);
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** @internal Verifies downloaded bytes against one reviewed lowercase SHA-256 pin. */
export function validateExternalToolArchiveIntegrity(archive: Uint8Array, expectedSha256: string): void {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new TypeError("Reviewed external tool digest must be a lowercase SHA-256 value");
  }
  const actual = createHash("sha256").update(archive).digest();
  const expected = Buffer.from(expectedSha256, "hex");
  if (!timingSafeEqual(actual, expected)) throw new Error("External tool archive integrity check failed");
}

async function archiveCommand(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await executeFile(executable, arguments_, {
    cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return result.stdout;
}

async function extractReviewedArchive(
  archivePath: string,
  extractionDirectory: string,
  artifact: ExternalToolArtifact,
  binary: string,
): Promise<void> {
  const zip = artifact.asset.endsWith(".zip");
  const listing = zip
    ? await archiveCommand("unzip", ["-Z1", archivePath], extractionDirectory)
    : await archiveCommand("tar", ["-tzf", archivePath], extractionDirectory);
  const entries = listing.split(/\r?\n/u).filter((entry) => entry !== "");
  validateExternalToolArchiveLayout(entries, artifact.asset, binary);
  if (zip) {
    await archiveCommand("unzip", ["-qq", archivePath, "-d", extractionDirectory], extractionDirectory);
  } else {
    await archiveCommand(
      "tar",
      ["-xzf", archivePath, "--directory", extractionDirectory, "--no-same-owner", "--no-same-permissions"],
      extractionDirectory,
    );
  }
}

async function installFd(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const artifact = getFdArtifact();
  if (artifact === undefined) throw new Error(`no reviewed artifact exists for ${process.platform}-${process.arch}`);
  const agentDirectory = getAgentDir(environment);
  const binDirectory = join(agentDirectory, "bin");
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const response = await fetch(artifact.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const archive = await responseBytes(response);
  validateExternalToolArchiveIntegrity(archive, artifact.sha256);
  const temporary = await mkdtemp(join(agentDirectory, ".external-tool-"));
  try {
    const archivePath = join(temporary, artifact.asset);
    const extracted = join(temporary, "extracted");
    await mkdir(extracted, { mode: 0o700 });
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
    await extractReviewedArchive(archivePath, extracted, artifact, "fd");
    const selected = await findExternalToolBinary(extracted, "fd");
    if (selected === undefined) throw new Error("archive does not contain fd");
    return await promoteExternalToolBinary(selected, join(binDirectory, fdBinaryName()));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function ensureFd(
  options: { environment?: NodeJS.ProcessEnv; silent?: boolean } = {},
): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const discovered = await getFdPath(environment);
  if (discovered !== undefined || offline(environment)) return discovered;
  const artifactNotice = getFdArtifact()?.notice;
  const key = resolve(getAgentDir(environment));
  let installing = inflight.get(key);
  if (installing === undefined) {
    installing = installFd(environment);
    inflight.set(key, installing);
    void installing.finally(() => {
      if (inflight.get(key) === installing) inflight.delete(key);
    }).catch(() => undefined);
  }
  try {
    const installed = await installing;
    if (artifactNotice !== undefined && options.silent !== true) {
      console.warn(`External tool notice: ${artifactNotice}.`);
    }
    return installed;
  } catch (error) {
    if (options.silent !== true) {
      const message = error instanceof Error ? error.message : "installation failed";
      console.warn(`Could not install fd: ${message}`);
    }
    return undefined;
  }
}
