import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface NestedGitWorktree {
  mainRoot: string;
  worktreeRoot: string;
}

const MAX_GIT_METADATA_BYTES = 4 * 1024;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function metadataPath(directory: string, contents: string, prefix?: string): string | undefined {
  const value = contents.trim();
  if (prefix !== undefined && !value.startsWith(prefix)) return undefined;
  const selected = prefix === undefined ? value : value.slice(prefix.length).trim();
  if (selected === "" || selected.includes("\n") || selected.includes("\r")) return undefined;
  return resolve(directory, selected);
}

function metadataContents(
  path: string,
  information: ReturnType<typeof lstatSync> = lstatSync(path),
): string | undefined {
  if (!information.isFile() || information.size > MAX_GIT_METADATA_BYTES) return undefined;
  return readFileSync(path, "utf8");
}

export function findNestedGitWorktree(cwd: string): NestedGitWorktree | undefined {
  let cursor: string;
  try {
    cursor = realpathSync(resolve(cwd));
  } catch {
    return undefined;
  }

  while (true) {
    const gitPath = join(cursor, ".git");
    let information: ReturnType<typeof lstatSync>;
    try {
      information = lstatSync(gitPath);
    } catch (error) {
      if (!isMissing(error)) return undefined;
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      cursor = parent;
      continue;
    }
    if (information.isDirectory() || !information.isFile()) return undefined;

    try {
      const gitMetadata = metadataContents(gitPath, information);
      if (gitMetadata === undefined) return undefined;
      const privatePath = metadataPath(cursor, gitMetadata, "gitdir:");
      if (privatePath === undefined) return undefined;
      const privateDirectory = realpathSync(privatePath);
      if (!lstatSync(privateDirectory).isDirectory()) return undefined;

      const commonMetadata = metadataContents(join(privateDirectory, "commondir"));
      if (commonMetadata === undefined) return undefined;
      const commonPath = metadataPath(
        privateDirectory,
        commonMetadata,
      );
      if (commonPath === undefined) return undefined;
      const commonDirectory = realpathSync(commonPath);
      if (!lstatSync(commonDirectory).isDirectory()) return undefined;

      const mainRoot = dirname(commonDirectory);
      const mainMetadata = join(mainRoot, ".git");
      if (!lstatSync(mainMetadata).isDirectory()
        || !samePath(realpathSync(mainMetadata), commonDirectory)) return undefined;

      const worktreeRoot = realpathSync(cursor);
      const nested = relative(mainRoot, worktreeRoot);
      if (nested === "" || nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
        return undefined;
      }
      return { mainRoot, worktreeRoot };
    } catch {
      return undefined;
    }
  }
}
