import { homedir } from "node:os";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, resolve } from "node:path";

import { runProcess } from "./runner.js";

export type GitProtocol = "https" | "ssh";

export const GIT_COMMAND_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
export const GIT_COMMAND_TIMEOUT_MS = 150_000;

export interface GitCommandSpec {
  argv: [string, ...string[]];
  arguments: string[];
  cwd: string;
  protocol: GitProtocol;
  home: string;
  template: string;
  signal: AbortSignal;
  timeoutMs?: number;
  outputLimitBytes?: number;
  platform?: NodeJS.Platform;
  sourceEnvironment?: NodeJS.ProcessEnv;
}

export interface ResolvedGitRemoteRef {
  fetchRef: string;
  revision: string;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const INVALID_REF_CHARACTER = /[\u0000-\u0020\u007f~^:?*[\\]/u;

function validRepositoryPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  for (const candidate of [pathname, decoded]) {
    if (CONTROL_CHARACTER.test(candidate) || candidate.includes("\\") || candidate.endsWith("/")) return false;
    const relative = candidate.startsWith("/") ? candidate.slice(1) : candidate;
    if (relative === "" || relative.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  }
  return true;
}

/** Validate the only remote transports accepted by package installation. */
export function gitRepositoryProtocol(repository: string): GitProtocol {
  if (
    repository.length === 0
    || repository.length > 4096
    || CONTROL_CHARACTER.test(repository)
    || repository.includes("?")
    || repository.includes("#")
  ) {
    throw new Error("Git repository must be a credential-free HTTPS or SSH URL");
  }
  const scp = repository.includes("://")
    ? null
    : /^(?:([A-Za-z0-9._-]{1,64})@)?([A-Za-z0-9.-]{1,253}):([A-Za-z0-9._~/-]{1,2048})$/u.exec(repository);
  if (scp !== null) {
    if (
      scp[2]!.startsWith(".")
      || scp[2]!.endsWith(".")
      || scp[3]!.startsWith("/")
      || !validRepositoryPath(scp[3]!)
    ) throw new Error("Git repository must be a credential-free HTTPS or SSH URL");
    return "ssh";
  }
  let parsed: URL;
  try {
    parsed = new URL(repository);
  } catch {
    throw new Error("Git repository must be a credential-free HTTPS or SSH URL");
  }
  const authority = repository.indexOf("://") + 3;
  const rawPathStart = repository.indexOf("/", authority);
  if (rawPathStart < 0 || !validRepositoryPath(repository.slice(rawPathStart))) {
    throw new Error("Git repository must be a credential-free HTTPS or SSH URL");
  }
  const protocol = parsed.protocol === "https:" ? "https" : parsed.protocol === "ssh:" ? "ssh" : undefined;
  if (
    protocol === undefined
    || parsed.hostname === ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname === ""
    || parsed.pathname === "/"
    || !validRepositoryPath(parsed.pathname)
    || (protocol === "https" && parsed.username !== "")
    || (protocol === "ssh" && parsed.username !== "" && !/^[A-Za-z0-9._-]{1,64}$/u.test(parsed.username))
  ) throw new Error("Git repository must be a credential-free HTTPS or SSH URL");
  return protocol;
}

/** Return a stable source identity without exposing URL components as filesystem names. */
export function gitRepositoryIdentity(repository: string): string {
  gitRepositoryProtocol(repository);
  const scp = repository.includes("://")
    ? null
    : /^(?:([A-Za-z0-9._-]{1,64})@)?([A-Za-z0-9.-]{1,253}):(.+)$/u.exec(repository);
  if (scp !== null) {
    const path = scp[3]!.replace(/\.git$/u, "");
    if (scp[1] === "git") return `${scp[2]!.toLowerCase()}/${path}`;
    const user = scp[1] === undefined ? "" : `${scp[1]}@`;
    return `ssh://${user}${scp[2]!.toLowerCase()}/${path}`;
  }
  const parsed = new URL(repository);
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\.git$/u, "");
  if (
    parsed.port === ""
    && (parsed.protocol === "https:" || (parsed.protocol === "ssh:" && parsed.username === "git"))
  ) return `${parsed.hostname}${parsed.pathname}`;
  return parsed.toString();
}

/** Accept advertised branches, tags, and full object IDs without permitting option/refspec injection. */
export function validateGitRef(ref: string): string {
  if (
    ref.length === 0
    || ref.length > 1024
    || ref.startsWith("-")
    || ref.startsWith("+")
    || ref === "@"
    || ref.startsWith("/")
    || ref.endsWith("/")
    || ref.endsWith(".")
    || ref.includes("..")
    || ref.includes("@{")
    || ref.includes("//")
    || INVALID_REF_CHARACTER.test(ref)
    || ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) throw new Error(`Invalid Git ref: ${ref}`);
  return ref;
}

const FULL_GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;

/** Resolve a moving ref deterministically, preferring a branch over a same-named tag. */
export async function resolveGitRemoteRef(
  run: (argumentsValue: string[], timeoutMs?: number) => Promise<string>,
  repository: string,
  requestedRef: string,
  timeoutMs?: number,
): Promise<ResolvedGitRemoteRef> {
  const ref = validateGitRef(requestedRef);
  if (FULL_GIT_OBJECT_ID.test(ref)) return { fetchRef: ref, revision: ref.toLowerCase() };
  const explicit = ref.startsWith("refs/");
  const branch = explicit ? (ref.startsWith("refs/heads/") ? ref : undefined) : `refs/heads/${ref}`;
  const tag = explicit ? (ref.startsWith("refs/tags/") ? ref : undefined) : `refs/tags/${ref}`;
  const candidates = explicit && branch === undefined && tag === undefined ? [ref] : [branch, tag, tag === undefined ? undefined : `${tag}^{}`]
    .filter((value): value is string => value !== undefined);
  const output = await run(["ls-remote", "--", repository, ...candidates], timeoutMs);
  const advertised = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\s+(\S+)$/iu.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) advertised.set(match[2], match[1].toLowerCase());
  }
  if (branch !== undefined) {
    const revision = advertised.get(branch);
    if (revision !== undefined) return { fetchRef: branch, revision };
  }
  if (tag !== undefined) {
    const revision = advertised.get(`${tag}^{}`) ?? advertised.get(tag);
    if (revision !== undefined) return { fetchRef: tag, revision };
  }
  if (explicit) {
    const revision = advertised.get(ref);
    if (revision !== undefined) return { fetchRef: ref, revision };
  }
  throw new Error(`Git ref was not advertised by the remote: ${ref}`);
}

export function gitCommandArguments(
  protocol: GitProtocol,
  hooksPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const nullDevice = platform === "win32" ? "NUL" : "/dev/null";
  return [
    "--no-pager",
    "-c", "advice.detachedHead=false",
    "-c", `core.attributesFile=${nullDevice}`,
    "-c", `core.excludesFile=${nullDevice}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${hooksPath}`,
    "-c", "credential.helper=",
    "-c", "credential.interactive=never",
    "-c", "diff.external=",
    "-c", "fetch.recurseSubmodules=false",
    "-c", "filter.lfs.clean=",
    "-c", "filter.lfs.process=",
    "-c", "filter.lfs.required=false",
    "-c", "filter.lfs.smudge=",
    "-c", "http.followRedirects=false",
    "-c", "http.sslVerify=true",
    "-c", "submodule.recurse=false",
    "-c", "protocol.allow=never",
    "-c", `protocol.${protocol}.allow=always`,
  ];
}

export function gitCommandEnvironment(
  home: string,
  template: string,
  protocol: GitProtocol,
  platform: NodeJS.Platform = process.platform,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  sshHome: string = homedir(),
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
    const value = sourceEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  const commandHome = protocol === "ssh" ? sshHome : home;
  const nullDevice = platform === "win32" ? "NUL" : "/dev/null";
  Object.assign(environment, {
    HOME: commandHome,
    USERPROFILE: commandHome,
    LANG: "C",
    LC_ALL: "C",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_EXTERNAL_DIFF: "",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    GIT_TEMPLATE_DIR: template,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  });
  if (protocol === "ssh") {
    environment.GIT_SSH_COMMAND = `ssh -F ${nullDevice} -oBatchMode=yes -oPermitLocalCommand=no -oProxyCommand=none`;
    for (const name of ["SSH_AUTH_SOCK", "SSH_AGENT_PID"]) {
      const value = sourceEnvironment[name];
      if (value !== undefined) environment[name] = value;
    }
  }
  return environment;
}

function commandFailureDetail(
  output: Buffer,
  totalBytes: number,
): string {
  const detail = output.toString("utf8").trim();
  return totalBytes > output.length ? `${detail}${detail === "" ? "" : "\n"}[output truncated]` : detail;
}

/** Resolve Git to a real executable; Windows command-script shims are intentionally rejected. */
export function resolveNativeGitExecutable(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const windows = platform === "win32";
  if (windows && /\.(?:bat|cmd|ps1)$/iu.test(command)) {
    throw new Error("Git must be a native executable, not a command-script shim");
  }
  const names = windows && extname(command) === "" ? [`${command}.exe`] : [command];
  const directories = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [""]
    : (environment.PATH ?? "").split(windows ? ";" : delimiter).filter((entry) => isAbsolute(entry));
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory === "" ? name : resolve(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        const selected = realpathSync(candidate);
        if (!statSync(selected).isFile()) continue;
        if (windows && !selected.toLowerCase().endsWith(".exe")) continue;
        return selected;
      } catch {
        // Continue searching the closed PATH.
      }
    }
  }
  throw new Error(`Unable to resolve native Git executable: ${command}`);
}

/** Run Git with a closed environment, bounded output/time, and whole-tree cancellation. */
export async function runGitCommand(spec: GitCommandSpec): Promise<string> {
  const platform = spec.platform ?? process.platform;
  const environment = gitCommandEnvironment(
    spec.home,
    spec.template,
    spec.protocol,
    platform,
    spec.sourceEnvironment,
  );
  const executable = resolveNativeGitExecutable(spec.argv[0], environment, platform);
  const result = await runProcess({
    argv: [
      executable,
      ...spec.argv.slice(1),
      ...gitCommandArguments(spec.protocol, spec.template, platform),
      ...spec.arguments,
    ],
    cwd: spec.cwd,
    env: environment,
    inheritEnv: false,
    timeoutMs: spec.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
    outputLimitBytes: spec.outputLimitBytes ?? GIT_COMMAND_OUTPUT_LIMIT_BYTES,
  }, spec.signal);
  if (result.cancelled) throw spec.signal.reason ?? new DOMException("Aborted", "AbortError");
  if (result.timedOut) {
    throw new Error(`git command timed out after ${spec.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS}ms`);
  }
  if (result.exitCode !== 0) {
    const stderr = commandFailureDetail(result.stderr, result.stderrBytes);
    const stdout = commandFailureDetail(result.stdout, result.stdoutBytes);
    const detail = stderr || stdout;
    throw new Error(
      `git command failed with ${result.exitCode === null ? `signal ${result.signal}` : `code ${result.exitCode}`}`
      + (detail === "" ? "" : `: ${detail}`),
    );
  }
  return result.stdout.toString("utf8").trim();
}
