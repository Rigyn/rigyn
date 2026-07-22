import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu;

interface PathFlavor {
  isAbsolute(path: string): boolean;
  parse(path: string): { root: string };
  relative(from: string, to: string): string;
  sep: string;
}

export interface PathInputOptions {
  trim?: boolean;
  expandTilde?: boolean;
  homeDir?: string;
  stripAtPrefix?: boolean;
  normalizeUnicodeSpaces?: boolean;
}

export function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isLocalPath(value: string): boolean {
  const protocol = /^(?:npm|git|github|https?|ssh):/iu;
  return !protocol.test(value.trim());
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
  let value = options.trim === true ? input.trim() : input;
  if (options.normalizeUnicodeSpaces === true) value = value.replace(UNICODE_SPACES, " ");
  if (options.stripAtPrefix === true && value.startsWith("@")) value = value.slice(1);

  if (options.expandTilde !== false) {
    const home = options.homeDir ?? homedir();
    if (value === "~") return home;
    if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
      return join(home, value.slice(2));
    }
  }

  return value.startsWith("file://") ? fileURLToPath(value) : value;
}

export function resolvePath(
  input: string,
  baseDirectory = process.cwd(),
  options: PathInputOptions = {},
): string {
  const path = normalizePath(input, options);
  const base = normalizePath(baseDirectory);
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

export function filesystemPathIdentity(input: string, baseDirectory = process.cwd()): string {
  const path = normalizePath(input);
  const windowsAbsolute = (process.platform === "win32" && win32.isAbsolute(path))
    || /^[a-z]:[\\/]/iu.test(path)
    || path.startsWith("\\\\");
  if (windowsAbsolute) return win32.resolve(path).toLowerCase();
  const resolved = resolvePath(path, baseDirectory);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function sameFilesystemPath(left: string, right: string): boolean {
  return filesystemPathIdentity(left) === filesystemPathIdentity(right);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
  const root = resolvePath(cwd);
  const path = resolvePath(filePath, root);
  const candidate = relative(root, path);
  if (candidate === "") return ".";
  if (candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) return undefined;
  return candidate;
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
  const absolute = resolvePath(filePath, cwd);
  return (getCwdRelativePath(absolute, cwd) ?? absolute).split(sep).join("/");
}

export function portableLocalPackageSource(
  base: string,
  target: string,
  paths: PathFlavor = { isAbsolute, parse, relative, sep },
): string {
  const baseRoot = paths.parse(base).root.toLowerCase();
  const targetRoot = paths.parse(target).root.toLowerCase();
  if (baseRoot !== targetRoot) return target.split(paths.sep).join("/");
  const path = paths.relative(base, target) || ".";
  const portable = path.split(paths.sep).join("/");
  if (paths.isAbsolute(path)) return portable;
  return portable === "." || portable.startsWith(".") ? portable : `./${portable}`;
}

/** Best-effort hint that managed package caches should not be synchronized. */
export function markPathIgnoredByCloudSync(path: string): void {
  const attributes = process.platform === "darwin"
    ? ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
    : process.platform === "linux"
      ? ["user.com.dropbox.ignored"]
      : [];
  for (const attribute of attributes) {
    try {
      if (process.platform === "darwin") {
        spawnSync("xattr", ["-w", attribute, "1", path], { stdio: "ignore" });
      } else {
        spawnSync("setfattr", ["-n", attribute, "-v", "1", path], { stdio: "ignore" });
      }
    } catch {
      // Cache usability must not depend on optional filesystem utilities.
    }
  }
}
