import { spawn } from "node:child_process";
import { release } from "node:os";

import {
  minimalClipboardEnvironment,
  runClipboardCommand,
  type ClipboardCommandRunner,
} from "./clipboard.js";

export type ClipboardTextBackend = "macos" | "powershell" | "wayland" | "x11" | "termux";

export interface ClipboardTextOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  osRelease?: string;
  runner?: ClipboardCommandRunner;
  signal?: AbortSignal;
}

export interface ClipboardTextResult {
  text?: string;
  backend?: ClipboardTextBackend;
}

const MAX_CLIPBOARD_TEXT_BYTES = 256 * 1024;
const READ_TIMEOUT_MS = 5_000;

function candidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  osRelease: string,
  write: boolean,
): Array<{ backend: ClipboardTextBackend; command: string; args: string[] }> {
  if (platform === "darwin") return [{ backend: "macos", command: write ? "pbcopy" : "pbpaste", args: [] }];
  if (platform === "win32") return [{
    backend: "powershell",
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", write
      ? "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())"
      : "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw"],
  }];
  if (platform !== "linux") return [];
  const result: Array<{ backend: ClipboardTextBackend; command: string; args: string[] }> = [];
  if (environment.TERMUX_VERSION !== undefined || environment.PREFIX?.includes("com.termux") === true) {
    result.push({ backend: "termux", command: write ? "termux-clipboard-set" : "termux-clipboard-get", args: [] });
  }
  const wayland = environment.WAYLAND_DISPLAY !== undefined || environment.XDG_SESSION_TYPE?.toLowerCase() === "wayland";
  if (wayland) result.push({ backend: "wayland", command: write ? "wl-copy" : "wl-paste", args: write ? ["--type", "text/plain;charset=utf-8"] : ["--no-newline", "--type", "text/plain;charset=utf-8"] });
  if (environment.DISPLAY !== undefined || wayland) {
    result.push(
      { backend: "x11", command: "xclip", args: write ? ["-selection", "clipboard", "-in"] : ["-selection", "clipboard", "-out"] },
      { backend: "x11", command: "xsel", args: write ? ["--clipboard", "--input"] : ["--clipboard", "--output"] },
    );
  }
  if (environment.WSL_DISTRO_NAME !== undefined || environment.WSLENV !== undefined || /microsoft|wsl/iu.test(osRelease)) {
    result.push({
      backend: "powershell",
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", write
        ? "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())"
        : "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw"],
    });
  }
  return result;
}

/** Reads bounded plain text from the native clipboard without invoking a shell. */
export async function readClipboardText(options: ClipboardTextOptions = {}): Promise<ClipboardTextResult> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? runClipboardCommand;
  for (const candidate of candidates(platform, environment, options.osRelease ?? release(), false)) {
    options.signal?.throwIfAborted();
    const result = await runner({
      command: candidate.command,
      args: candidate.args,
      environment,
      timeoutMs: READ_TIMEOUT_MS,
      maxOutputBytes: MAX_CLIPBOARD_TEXT_BYTES,
    }, options.signal);
    if (!result.ok || result.stdout.byteLength === 0) continue;
    const text = Buffer.from(result.stdout).toString("utf8").replace(/\0+$/u, "");
    if (text !== "") return { text, backend: candidate.backend };
  }
  return {};
}

function writeCandidate(
  candidate: { backend: ClipboardTextBackend; command: string; args: string[] },
  text: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(candidate.command, candidate.args, {
        env: minimalClipboardEnvironment(environment),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(ok);
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(false);
    };
    const timer = setTimeout(abort, READ_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin?.once("error", () => finish(false));
    child.stdin?.end(text, "utf8");
    if (signal?.aborted === true) abort();
  });
}

/** Copies bounded text using native platform helpers. Returns the helper used. */
export async function copyToNativeClipboard(text: string, options: ClipboardTextOptions = {}): Promise<ClipboardTextBackend | undefined> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0) throw new Error("There is no text to copy");
  if (bytes > 100 * 1024) throw new Error("Text exceeds the 100 KiB clipboard limit");
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  for (const candidate of candidates(platform, environment, options.osRelease ?? release(), true)) {
    options.signal?.throwIfAborted();
    if (await writeCandidate(candidate, text, environment, options.signal)) return candidate.backend;
  }
  return undefined;
}
