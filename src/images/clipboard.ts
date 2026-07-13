import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_PREPROCESS_INPUT_BYTES,
  sniffImageMediaType,
  type SniffedImageMediaType,
} from "./preprocess.js";

export type ClipboardBackend = "macos" | "powershell" | "wayland" | "x11" | "termux";

export interface ClipboardImage {
  bytes: Uint8Array;
  mediaType: SniffedImageMediaType;
  backend: ClipboardBackend;
}

export interface ClipboardDiagnostic {
  backend: ClipboardBackend;
  outcome: "unavailable" | "empty" | "invalid" | "failed";
  detail: string;
}

export interface ClipboardImageResult {
  image?: ClipboardImage;
  diagnostics: ClipboardDiagnostic[];
}

export interface ClipboardCommandSpec {
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ClipboardCommandResult {
  ok: boolean;
  stdout: Uint8Array;
  exitCode: number | null;
  errorCode?: string;
  timedOut: boolean;
  outputLimited: boolean;
  aborted: boolean;
}

export type ClipboardCommandRunner = (spec: ClipboardCommandSpec, signal?: AbortSignal) => Promise<ClipboardCommandResult>;

export interface ClipboardImageOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  osRelease?: string;
  runner?: ClipboardCommandRunner;
  signal?: AbortSignal;
}

const MAX_TYPE_LIST_BYTES = 64 * 1024;
const MAX_DIAGNOSTICS = 16;
const LIST_TIMEOUT_MS = 1_500;
const READ_TIMEOUT_MS = 5_000;
const POWERSHELL_TIMEOUT_MS = 8_000;

const MIME_PREFERENCE = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
] as const;

const ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "WSL_DISTRO_NAME",
  "WSLENV",
  "TERMUX_VERSION",
  "PREFIX",
  "LD_LIBRARY_PATH",
] as const;

/** Removes inherited runtime injection variables before launching clipboard helpers. */
export function minimalClipboardEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  for (const key of ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined && value !== "" && !value.includes("\0")) selected[key] = value;
  }
  return selected;
}

function commandInput(spec: ClipboardCommandSpec): void {
  if (
    spec.command === ""
    || spec.command.includes("\0")
    || spec.args.length > 64
    || spec.args.some((argument) => argument.includes("\0") || Buffer.byteLength(argument, "utf8") > 64 * 1024)
  ) throw new Error("Invalid clipboard helper command");
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 30_000) {
    throw new RangeError("Clipboard helper timeout is invalid");
  }
  if (!Number.isSafeInteger(spec.maxOutputBytes) || spec.maxOutputBytes < 1 || spec.maxOutputBytes > MAX_PREPROCESS_INPUT_BYTES) {
    throw new RangeError("Clipboard helper output limit is invalid");
  }
}

/** Executes one fixed argv command without a shell and with bounded output. */
export const runClipboardCommand: ClipboardCommandRunner = async (spec, signal) => {
  commandInput(spec);
  signal?.throwIfAborted();
  return await new Promise<ClipboardCommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, [...spec.args], {
        env: minimalClipboardEnvironment(spec.environment),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: new Uint8Array(),
        exitCode: null,
        errorCode: (error as NodeJS.ErrnoException).code ?? "SPAWN_ERROR",
        timedOut: false,
        outputLimited: false,
        aborted: false,
      });
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let aborted = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let settled = false;
    const stop = () => {
      if (!child.killed) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    timer.unref();
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputLimited) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > spec.maxOutputBytes) {
        outputLimited = true;
        stop();
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 16 * 1024) stop();
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const data = outputLimited ? new Uint8Array() : new Uint8Array(Buffer.concat(stdout, stdoutBytes));
      resolve({
        ok: code === 0 && spawnError === undefined && !timedOut && !outputLimited && !aborted,
        stdout: data,
        exitCode: code,
        ...(spawnError?.code === undefined ? {} : { errorCode: spawnError.code }),
        timedOut,
        outputLimited,
        aborted,
      });
    });
  });
};

function resultDiagnostic(backend: ClipboardBackend, phase: string, result: ClipboardCommandResult): ClipboardDiagnostic {
  if (result.errorCode === "ENOENT") return { backend, outcome: "unavailable", detail: `${phase} helper is not installed` };
  if (result.timedOut) return { backend, outcome: "failed", detail: `${phase} helper timed out` };
  if (result.outputLimited) return { backend, outcome: "failed", detail: `${phase} clipboard data exceeded the safety limit` };
  if (result.aborted) return { backend, outcome: "failed", detail: `${phase} clipboard read was cancelled` };
  return { backend, outcome: "empty", detail: `${phase} did not provide an image` };
}

function addDiagnostic(diagnostics: ClipboardDiagnostic[], diagnostic: ClipboardDiagnostic): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
}

function imageFromBytes(
  backend: ClipboardBackend,
  data: Uint8Array,
  diagnostics: ClipboardDiagnostic[],
  claimedMediaType?: string,
): ClipboardImage | undefined {
  if (data.byteLength < 1) {
    addDiagnostic(diagnostics, { backend, outcome: "empty", detail: "Clipboard image data was empty" });
    return undefined;
  }
  const mediaType = sniffImageMediaType(data);
  if (mediaType === undefined) {
    addDiagnostic(diagnostics, { backend, outcome: "invalid", detail: "Clipboard bytes did not contain a recognized image signature" });
    return undefined;
  }
  if (claimedMediaType !== undefined && claimedMediaType !== mediaType) {
    addDiagnostic(diagnostics, { backend, outcome: "invalid", detail: `Clipboard advertised ${claimedMediaType} but contained ${mediaType}` });
  }
  return { bytes: new Uint8Array(data), mediaType, backend };
}

function normalizedMimeTypes(data: Uint8Array): string[] {
  const values = Buffer.from(data).toString("utf8").split(/\r?\n/u);
  const normalized = values
    .map((value) => value.split(";", 1)[0]?.trim().toLowerCase() ?? "")
    .filter((value) => value !== "" && value.length <= 127);
  return [...new Set(normalized)].slice(0, 256);
}

function preferredMimeTypes(types: readonly string[]): string[] {
  const selected = MIME_PREFERENCE.filter((mimeType) => types.includes(mimeType));
  return selected.length === 0 ? [] : selected;
}

async function command(
  runner: ClipboardCommandRunner,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<ClipboardCommandResult> {
  return await runner({ command: executable, args, environment, timeoutMs, maxOutputBytes }, signal);
}

async function readWayland(
  runner: ClipboardCommandRunner,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  diagnostics: ClipboardDiagnostic[],
): Promise<ClipboardImage | undefined> {
  const listed = await command(runner, environment, signal, "wl-paste", ["--list-types"], LIST_TIMEOUT_MS, MAX_TYPE_LIST_BYTES);
  if (!listed.ok) {
    addDiagnostic(diagnostics, resultDiagnostic("wayland", "wl-paste", listed));
    return undefined;
  }
  const types = preferredMimeTypes(normalizedMimeTypes(listed.stdout));
  if (types.length === 0) {
    addDiagnostic(diagnostics, { backend: "wayland", outcome: "empty", detail: "Wayland clipboard has no supported image type" });
    return undefined;
  }
  for (const mimeType of types) {
    const read = await command(
      runner,
      environment,
      signal,
      "wl-paste",
      ["--no-newline", "--type", mimeType],
      READ_TIMEOUT_MS,
      MAX_PREPROCESS_INPUT_BYTES,
    );
    if (read.ok) {
      const image = imageFromBytes("wayland", read.stdout, diagnostics, mimeType);
      if (image !== undefined) return image;
    } else addDiagnostic(diagnostics, resultDiagnostic("wayland", "wl-paste", read));
  }
  return undefined;
}

async function readX11(
  runner: ClipboardCommandRunner,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  diagnostics: ClipboardDiagnostic[],
): Promise<ClipboardImage | undefined> {
  const listed = await command(
    runner,
    environment,
    signal,
    "xclip",
    ["-selection", "clipboard", "-target", "TARGETS", "-out"],
    LIST_TIMEOUT_MS,
    MAX_TYPE_LIST_BYTES,
  );
  if (!listed.ok && listed.errorCode === "ENOENT") {
    addDiagnostic(diagnostics, resultDiagnostic("x11", "xclip", listed));
    return undefined;
  }
  const types = listed.ok ? preferredMimeTypes(normalizedMimeTypes(listed.stdout)) : [...MIME_PREFERENCE];
  if (types.length === 0) {
    addDiagnostic(diagnostics, { backend: "x11", outcome: "empty", detail: "X11 clipboard has no supported image type" });
    return undefined;
  }
  for (const mimeType of types) {
    const read = await command(
      runner,
      environment,
      signal,
      "xclip",
      ["-selection", "clipboard", "-target", mimeType, "-out"],
      READ_TIMEOUT_MS,
      MAX_PREPROCESS_INPUT_BYTES,
    );
    if (read.ok) {
      const image = imageFromBytes("x11", read.stdout, diagnostics, mimeType);
      if (image !== undefined) return image;
    } else addDiagnostic(diagnostics, resultDiagnostic("x11", "xclip", read));
  }
  return undefined;
}

const POWERSHELL_IMAGE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$image=[System.Windows.Forms.Clipboard]::GetImage()",
  "if($null -eq $image){exit 3}",
  "$stream=[System.IO.MemoryStream]::new()",
  "try{$image.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png);$bytes=$stream.ToArray();$stdout=[Console]::OpenStandardOutput();$stdout.Write($bytes,0,$bytes.Length);$stdout.Flush()}finally{$stream.Dispose();$image.Dispose()}",
].join(";");

async function readPowerShell(
  runner: ClipboardCommandRunner,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  diagnostics: ClipboardDiagnostic[],
  executables: readonly string[],
): Promise<ClipboardImage | undefined> {
  for (const executable of executables) {
    const read = await command(
      runner,
      environment,
      signal,
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", POWERSHELL_IMAGE_SCRIPT],
      POWERSHELL_TIMEOUT_MS,
      MAX_PREPROCESS_INPUT_BYTES,
    );
    if (read.ok) {
      const image = imageFromBytes("powershell", read.stdout, diagnostics, "image/png");
      if (image !== undefined) return image;
    } else addDiagnostic(diagnostics, resultDiagnostic("powershell", executable, read));
    if (read.errorCode !== "ENOENT") break;
  }
  return undefined;
}

const MACOS_IMAGE_SCRIPT = `on run argv
set destination to POSIX file (item 1 of argv)
try
  set imageData to the clipboard as «class PNGf»
on error
  try
    set imageData to the clipboard as «class JPEG»
  on error
    set imageData to the clipboard as «class TIFF»
  end try
end try
set outputFile to open for access destination with write permission
try
  set eof outputFile to 0
  write imageData to outputFile
  close access outputFile
on error messageText number messageNumber
  try
    close access outputFile
  end try
  error messageText number messageNumber
end try
return "ok"
end run`;

async function readMacOS(
  runner: ClipboardCommandRunner,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  diagnostics: ClipboardDiagnostic[],
): Promise<ClipboardImage | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-clipboard-"));
  const destination = join(directory, "image.bin");
  try {
    const read = await command(
      runner,
      environment,
      signal,
      "osascript",
      ["-e", MACOS_IMAGE_SCRIPT, destination],
      READ_TIMEOUT_MS,
      4 * 1024,
    );
    if (!read.ok) {
      addDiagnostic(diagnostics, resultDiagnostic("macos", "osascript", read));
      return undefined;
    }
    try {
      const stats = await lstat(destination);
      if (!stats.isFile() || stats.size < 1 || stats.size > MAX_PREPROCESS_INPUT_BYTES) {
        addDiagnostic(diagnostics, { backend: "macos", outcome: "invalid", detail: "macOS clipboard image file was unsafe or oversized" });
        return undefined;
      }
      return imageFromBytes("macos", await readFile(destination), diagnostics);
    } catch {
      addDiagnostic(diagnostics, { backend: "macos", outcome: "empty", detail: "macOS clipboard did not produce image bytes" });
      return undefined;
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readTermux(
  runner: ClipboardCommandRunner,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  diagnostics: ClipboardDiagnostic[],
): Promise<ClipboardImage | undefined> {
  const read = await command(
    runner,
    environment,
    signal,
    "termux-clipboard-get",
    [],
    READ_TIMEOUT_MS,
    MAX_PREPROCESS_INPUT_BYTES,
  );
  if (!read.ok) {
    addDiagnostic(diagnostics, resultDiagnostic("termux", "termux-clipboard-get", read));
    return undefined;
  }
  const image = imageFromBytes("termux", read.stdout, diagnostics);
  if (image === undefined) {
    addDiagnostic(diagnostics, { backend: "termux", outcome: "unavailable", detail: "Termux clipboard API exposed text rather than binary image data" });
  }
  return image;
}

function waylandSession(environment: NodeJS.ProcessEnv): boolean {
  return environment.WAYLAND_DISPLAY !== undefined || environment.XDG_SESSION_TYPE?.toLowerCase() === "wayland";
}

function wslSession(environment: NodeJS.ProcessEnv, osRelease: string): boolean {
  return environment.WSL_DISTRO_NAME !== undefined || environment.WSLENV !== undefined || /microsoft|wsl/iu.test(osRelease);
}

function termuxSession(environment: NodeJS.ProcessEnv): boolean {
  return environment.TERMUX_VERSION !== undefined || environment.PREFIX?.includes("com.termux") === true;
}

/** Reads one clipboard image using detected platform facilities. It never invokes a shell. */
export async function readClipboardImage(options: ClipboardImageOptions = {}): Promise<ClipboardImageResult> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? runClipboardCommand;
  const signal = options.signal;
  signal?.throwIfAborted();
  const diagnostics: ClipboardDiagnostic[] = [];
  let image: ClipboardImage | undefined;

  if (platform === "darwin") image = await readMacOS(runner, environment, signal, diagnostics);
  else if (platform === "win32") {
    image = await readPowerShell(runner, environment, signal, diagnostics, ["powershell.exe", "pwsh.exe"]);
  } else if (platform === "linux") {
    if (termuxSession(environment)) image = await readTermux(runner, environment, signal, diagnostics);
    const wayland = waylandSession(environment);
    if (image === undefined && wayland) image = await readWayland(runner, environment, signal, diagnostics);
    if (image === undefined && (environment.DISPLAY !== undefined || wayland)) {
      image = await readX11(runner, environment, signal, diagnostics);
    }
    if (image === undefined && wslSession(environment, options.osRelease ?? release())) {
      image = await readPowerShell(runner, environment, signal, diagnostics, ["powershell.exe"]);
    }
    if (image === undefined && !termuxSession(environment) && !wayland && environment.DISPLAY === undefined) {
      addDiagnostic(diagnostics, { backend: "x11", outcome: "unavailable", detail: "No graphical clipboard session was detected" });
    }
  } else {
    addDiagnostic(diagnostics, { backend: "x11", outcome: "unavailable", detail: `Clipboard images are unsupported on platform ${platform}` });
  }
  return { ...(image === undefined ? {} : { image }), diagnostics };
}
