import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export interface NormalizePathOptions {
  normalizeUnicodeSpaces?: boolean;
  stripAtPrefix?: boolean;
}

const WINDOWS_ABSOLUTE = /^[a-z]:[\\/]/iu;

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

export function normalizePath(value: string, options: NormalizePathOptions = {}): string {
  let normalized = value.trim();
  if (options.stripAtPrefix && normalized.startsWith("@")) normalized = normalized.slice(1);
  if (options.normalizeUnicodeSpaces) normalized = normalized.replace(/[\u00a0\u2007\u202f]/gu, " ");
  normalized = expandHome(normalized);
  if (WINDOWS_ABSOLUTE.test(normalized)) return win32.normalize(normalized);
  return normalize(normalized);
}

export function resolvePath(value: string, cwd = process.cwd()): string {
  const candidate = value.trim();
  if (/^file:/iu.test(candidate)) return fileURLToPath(candidate);
  const normalized = normalizePath(candidate);
  if (WINDOWS_ABSOLUTE.test(normalized)) return win32.resolve(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

export function isLocalPath(value: string): boolean {
  const candidate = value.trim();
  if (/^file:/iu.test(candidate) || WINDOWS_ABSOLUTE.test(candidate)) return true;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(candidate)) return false;
  return candidate.startsWith(".") || candidate.startsWith("~") || isAbsolute(candidate);
}

export function canonicalizePath(value: string): string {
  const resolved = resolvePath(value);
  const normalized = WINDOWS_ABSOLUTE.test(resolved) ? win32.normalize(resolved) : resolved;
  try {
    return realpathSync.native(normalized);
  } catch {
    return normalized;
  }
}

export function filesystemPathIdentity(value: string): string {
  const identity = canonicalizePath(value);
  if (WINDOWS_ABSOLUTE.test(identity)) return win32.normalize(identity.replaceAll("/", "\\")).toLowerCase();
  return process.platform === "win32" ? identity.toLowerCase() : identity;
}

export function sameFilesystemPath(left: string, right: string): boolean {
  return filesystemPathIdentity(left) === filesystemPathIdentity(right);
}

interface PathFlavor {
	isAbsolute(path: string): boolean;
	parse(path: string): { root: string };
	relative(from: string, to: string): string;
	sep: string;
}

export function portableLocalPackageSource(base: string, target?: string, paths?: PathFlavor): string {
	if (target === undefined) {
		const normalized = base.replaceAll("\\", "/");
		return normalized.startsWith(".") || isAbsolute(base) ? normalized : `./${normalized}`;
	}
	const flavor = paths ?? { isAbsolute, parse: (path) => ({ root: path.startsWith(sep) ? sep : "" }), relative, sep };
	const baseRoot = flavor.parse(base).root.toLowerCase();
	const targetRoot = flavor.parse(target).root.toLowerCase();
	if (baseRoot !== targetRoot) return target.replaceAll(flavor.sep, "/");
	const local = flavor.relative(base, target).replaceAll(flavor.sep, "/");
	return local.startsWith(".") ? local : `./${local}`;
}

export function markPathIgnoredByCloudSync(_path: string): void {
  // Cloud-sync hints are best-effort and deliberately cannot block startup.
}
