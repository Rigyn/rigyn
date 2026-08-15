export interface ParsedGitUrl {
  host: string;
  path: string;
  repo: string;
  ref?: string;
  pinned: boolean;
}

function safePath(path: string): string | undefined {
  if (path.includes("\\")) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return undefined; }
  const segments = decoded.split("/");
  if (segments.length < 2 || segments.some((part) => part === "" || part === "." || part === ".." || part.includes("/"))) return undefined;
  return segments.join("/").replace(/\.git$/u, "");
}

export function parseGitUrl(input: string): ParsedGitUrl | undefined {
  if (input.includes("\\")) return undefined;
  const explicitlyGit = input.startsWith("git:");
  let value = explicitlyGit ? input.slice(4) : input;
  if (!explicitlyGit && !/^https:\/\/|^ssh:\/\//u.test(value)) return undefined;
  let ref: string | undefined;
  const hash = value.lastIndexOf("#");
  if (hash >= 0) { ref = value.slice(hash + 1) || undefined; value = value.slice(0, hash); }
  if (ref === undefined) {
    const slash = value.lastIndexOf("/");
    const at = value.lastIndexOf("@");
    if (at > slash) { ref = value.slice(at + 1) || undefined; value = value.slice(0, at); }
  }
  let host: string;
  let path: string;
  let repo: string;
  const scp = /^(?:git@)?([^/:]+):(.+)$/u.exec(value);
  if (scp !== null && !value.includes("://")) {
    host = scp[1]!;
    path = scp[2]!;
    repo = value;
  } else {
    const normalized = /^[^/:]+\/.+/u.test(value) ? `https://${value}` : value;
    let url: URL;
    try { url = new URL(normalized); } catch { return undefined; }
    if (url.protocol !== "https:" && url.protocol !== "ssh:") return undefined;
    host = url.hostname;
    path = url.pathname.replace(/^\//u, "");
    repo = normalized;
  }
  const normalizedPath = safePath(path);
  if (host === "" || normalizedPath === undefined) return undefined;
  return { host: host.toLowerCase(), path: normalizedPath, repo, ...(ref === undefined ? {} : { ref }), pinned: ref !== undefined && /^[a-f0-9]{40}$/u.test(ref) };
}
