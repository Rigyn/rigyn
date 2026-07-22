export interface GitSource {
  type: "git";
  repo: string;
  host: string;
  path: string;
  ref?: string;
  pinned: boolean;
}

function decodeSafe(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function safeInstallPart(value: string, slashAllowed: boolean): boolean {
  const decoded = decodeSafe(value);
  if (decoded === undefined) return false;
  for (const candidate of [value, decoded]) {
    if (candidate.includes("\0") || candidate.includes("\\") || candidate.startsWith("/")) return false;
    if (!slashAllowed && candidate.includes("/")) return false;
    if (candidate.split("/").includes("..")) return false;
  }
  return true;
}

function splitRef(value: string): { repo: string; ref?: string } {
  const scp = /^([A-Za-z0-9._-]{1,64})@([^:]+):(.+)$/u.exec(value);
  if (scp !== null) {
    const path = scp[3] ?? "";
    const fragment = path.indexOf("#");
    if (fragment > 0 && fragment < path.length - 1) {
      return { repo: `${scp[1]}@${scp[2]}:${path.slice(0, fragment)}`, ref: path.slice(fragment + 1) };
    }
    const marker = path.indexOf("@");
    if (marker > 0 && marker < path.length - 1) {
      return { repo: `${scp[1]}@${scp[2]}:${path.slice(0, marker)}`, ref: path.slice(marker + 1) };
    }
    return { repo: value };
  }

  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (url.hash.length > 1) {
        const ref = url.hash.slice(1);
        url.hash = "";
        return { repo: url.toString().replace(/\/$/u, ""), ref };
      }
      const path = url.pathname.replace(/^\/+/, "");
      const marker = path.indexOf("@");
      if (marker > 0 && marker < path.length - 1) {
        const ref = path.slice(marker + 1);
        url.pathname = `/${path.slice(0, marker)}`;
        return { repo: url.toString().replace(/\/$/u, ""), ref };
      }
    } catch {
      return { repo: value };
    }
    return { repo: value };
  }

  const slash = value.indexOf("/");
  if (slash < 0) return { repo: value };
  const path = value.slice(slash + 1);
  const fragment = path.indexOf("#");
  if (fragment > 0 && fragment < path.length - 1) {
    return { repo: `${value.slice(0, slash)}/${path.slice(0, fragment)}`, ref: path.slice(fragment + 1) };
  }
  const marker = path.indexOf("@");
  return marker > 0 && marker < path.length - 1
    ? { repo: `${value.slice(0, slash)}/${path.slice(0, marker)}`, ref: path.slice(marker + 1) }
    : { repo: value };
}

function finish(repo: string, host: string, rawPath: string, ref?: string): GitSource | undefined {
  if (rawPath.startsWith("/")) return undefined;
  const path = rawPath.replace(/^\/+|\.git$/gu, "");
  if (host === "" || path.split("/").length < 2) return undefined;
  if (!safeInstallPart(host, false) || !safeInstallPart(path, true)) return undefined;
  return {
    type: "git",
    repo,
    host,
    path,
    ...(ref === undefined ? {} : { ref }),
    pinned: ref !== undefined && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(ref),
  };
}

export function parseGitUrl(source: string): GitSource | undefined {
  const trimmed = source.trim();
  const prefixed = trimmed.startsWith("git:");
  const raw = prefixed ? trimmed.slice(4).trim() : trimmed;
  if (!prefixed && !/^(?:https?|ssh|git):\/\//iu.test(raw)) return undefined;

  const { repo: splitRepo, ref } = splitRef(raw);
  const scp = /^([A-Za-z0-9._-]{1,64})@([^:]+):(.+)$/u.exec(splitRepo);
  if (scp !== null) return finish(splitRepo, scp[2] ?? "", scp[3] ?? "", ref);

  if (splitRepo.includes("://")) {
    try {
      const url = new URL(splitRepo);
      return finish(splitRepo, url.hostname, url.pathname.replace(/^\/+/, ""), ref);
    } catch {
      return undefined;
    }
  }

  const slash = splitRepo.indexOf("/");
  if (slash < 0) return undefined;
  const host = splitRepo.slice(0, slash);
  if (!host.includes(".") && host !== "localhost") return undefined;
  return finish(`https://${splitRepo}`, host, splitRepo.slice(slash + 1), ref);
}
