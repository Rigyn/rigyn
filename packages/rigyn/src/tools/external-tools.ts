import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { arch, platform } from "node:os";
import { basename, join } from "node:path";

import { APP_NAME, getBinDir } from "../config/paths.js";
import { resolveExecutable } from "../process/runner.js";

export type ExternalSearchTool = "fd" | "rg";

interface ToolRelease {
  binary: string;
  displayName: string;
  repository: string;
  systemNames: readonly string[];
  tagPrefix: string;
  asset(version: string, operatingSystem: string, architecture: string): string | undefined;
}

const RELEASES: Record<ExternalSearchTool, ToolRelease> = {
  fd: {
    binary: "fd",
    displayName: "fd",
    repository: "sharkdp/fd",
    systemNames: ["fd", "fdfind"],
    tagPrefix: "v",
    asset(version, operatingSystem, architecture) {
      const cpu = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
      if (cpu === undefined) return undefined;
      if (operatingSystem === "darwin") return `fd-v${version}-${cpu}-apple-darwin.tar.gz`;
      if (operatingSystem === "linux") return `fd-v${version}-${cpu}-unknown-linux-gnu.tar.gz`;
      if (operatingSystem === "win32") return `fd-v${version}-${cpu}-pc-windows-msvc.zip`;
      return undefined;
    },
  },
  rg: {
    binary: "rg",
    displayName: "ripgrep",
    repository: "BurntSushi/ripgrep",
    systemNames: ["rg"],
    tagPrefix: "",
    asset(version, operatingSystem, architecture) {
      if (operatingSystem === "darwin") {
        const cpu = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
        return cpu === undefined ? undefined : `ripgrep-${version}-${cpu}-apple-darwin.tar.gz`;
      }
      if (operatingSystem === "linux") {
        if (architecture === "arm64") return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
        if (architecture === "x64") return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
      }
      if (operatingSystem === "win32") {
        const cpu = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
        return cpu === undefined ? undefined : `ripgrep-${version}-${cpu}-pc-windows-msvc.zip`;
      }
      return undefined;
    },
  },
};

const inflight = new Map<ExternalSearchTool, Promise<string | undefined>>();

function enabled(value: string | undefined): boolean {
  return /^(?:1|true|yes)$/iu.test(value ?? "");
}

function executableName(tool: ToolRelease, operatingSystem = platform()): string {
  return `${tool.binary}${operatingSystem === "win32" ? ".exe" : ""}`;
}

async function executableFile(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.X_OK);
    const resolved = await realpath(path);
    return (await stat(resolved)).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function getExternalToolPath(
  tool: ExternalSearchTool,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const release = RELEASES[tool];
  const cached = await executableFile(join(getBinDir(environment), executableName(release)));
  if (cached !== undefined) return cached;
  for (const name of release.systemNames) {
    const command = platform() === "win32" ? `${name}.exe` : name;
    const resolved = await resolveExecutable(command, { environment });
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

async function latestVersion(release: ToolRelease): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${release.repository}/releases/latest`, {
    headers: { "user-agent": `${APP_NAME}-coding-agent` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed with HTTP ${response.status}`);
  const value = await response.json() as { tag_name?: unknown };
  if (typeof value.tag_name !== "string" || value.tag_name === "") {
    throw new Error("GitHub release response did not include a version tag");
  }
  return value.tag_name.replace(/^v/u, "");
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Tool download failed with HTTP ${response.status}`);
  if (response.body === null) throw new Error("Tool download returned no response body");
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()), { flag: "wx" });
}

function extractionFailure(command: string, args: readonly string[]): string | undefined {
  const result = spawnSync(command, [...args], { encoding: "utf8", stdio: "pipe", windowsHide: true });
  if (result.error === undefined && result.status === 0) return undefined;
  return result.error?.message ?? result.stderr.trim() ?? result.stdout.trim() ?? `exit status ${String(result.status)}`;
}

function windowsTar(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return systemRoot === undefined ? "tar.exe" : join(systemRoot, "System32", "tar.exe");
}

function extract(archive: string, destination: string): void {
  if (archive.endsWith(".tar.gz")) {
    const failure = extractionFailure("tar", ["xzf", archive, "-C", destination]);
    if (failure !== undefined) throw new Error(`Cannot extract ${basename(archive)}: ${failure}`);
    return;
  }
  if (!archive.endsWith(".zip")) throw new Error(`Unsupported tool archive: ${basename(archive)}`);
  const failures: string[] = [];
  const tar = platform() === "win32" ? windowsTar() : "unzip";
  const tarArgs = platform() === "win32" ? ["xf", archive, "-C", destination] : ["-q", archive, "-d", destination];
  const first = extractionFailure(tar, tarArgs);
  if (first === undefined) return;
  failures.push(first);
  if (platform() === "win32") {
    const script = "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    const powershell = extractionFailure("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", script, archive, destination,
    ]);
    if (powershell === undefined) return;
    failures.push(powershell);
  } else {
    const fallback = extractionFailure("tar", ["xf", archive, "-C", destination]);
    if (fallback === undefined) return;
    failures.push(fallback);
  }
  throw new Error(`Cannot extract ${basename(archive)}: ${failures.join("; ")}`);
}

async function findBinary(directory: string, name: string): Promise<string | undefined> {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = join(current, entry.name);
      if (entry.isFile() && entry.name === name) return candidate;
      if (entry.isDirectory()) stack.push(candidate);
    }
  }
  return undefined;
}

async function installTool(tool: ExternalSearchTool, environment: NodeJS.ProcessEnv): Promise<string> {
  const release = RELEASES[tool];
  let version = await latestVersion(release);
  if (tool === "fd" && platform() === "darwin" && arch() === "x64") version = "10.3.0";
  const asset = release.asset(version, platform(), arch());
  if (asset === undefined) throw new Error(`Unsupported platform: ${platform()}/${arch()}`);
  const directory = getBinDir(environment);
  await mkdir(directory, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const archive = join(directory, `.${asset}.${nonce}`);
  const extracted = join(directory, `.extract-${release.binary}-${nonce}`);
  await mkdir(extracted);
  try {
    const url = `https://github.com/${release.repository}/releases/download/${release.tagPrefix}${version}/${asset}`;
    await download(url, archive);
    extract(archive, extracted);
    const name = executableName(release);
    const source = await findBinary(extracted, name);
    if (source === undefined) throw new Error(`Downloaded archive did not contain ${name}`);
    const destination = join(directory, name);
    await rename(source, destination);
    if (platform() !== "win32") await chmod(destination, 0o755);
    return await realpath(destination);
  } finally {
    await rm(archive, { force: true });
    await rm(extracted, { recursive: true, force: true });
  }
}

export async function ensureExternalTool(
  tool: ExternalSearchTool,
  options: { environment?: NodeJS.ProcessEnv; silent?: boolean } = {},
): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const existing = await getExternalToolPath(tool, environment);
  if (existing !== undefined) return existing;
  const release = RELEASES[tool];
  if (enabled(environment.RIGYN_OFFLINE)) {
    if (options.silent !== true) console.warn(`${release.displayName} not found; offline mode prevents download.`);
    return undefined;
  }
  if (platform() === "android") {
    if (options.silent !== true) console.warn(`${release.displayName} not found; install it with: pkg install ${tool === "rg" ? "ripgrep" : "fd"}`);
    return undefined;
  }
  const active = inflight.get(tool);
  if (active !== undefined) return await active;
  const request = installTool(tool, environment).catch((error: unknown) => {
    if (options.silent !== true) {
      console.warn(`Could not install ${release.displayName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }).finally(() => {
    inflight.delete(tool);
  });
  inflight.set(tool, request);
  return await request;
}
