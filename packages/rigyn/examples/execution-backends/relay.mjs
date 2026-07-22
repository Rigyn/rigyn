import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, win32 } from "node:path";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

export function requiredOption(args, name) {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function absoluteOption(args, name) {
  const value = requiredOption(args, name);
  if (!isAbsolute(value) || value.includes("\0")) throw new Error(`${name} must be an absolute path`);
  return value;
}

export function parseRequest(input, expectedWorkspace) {
  if (input.byteLength > MAX_REQUEST_BYTES) throw new Error(`Request exceeds ${MAX_REQUEST_BYTES} bytes`);
  let request;
  try {
    request = JSON.parse(input.toString("utf8"));
  } catch {
    throw new Error("Request is not valid JSON");
  }
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    request.schemaVersion !== 1 ||
    typeof request.tool !== "string" ||
    request.input === undefined ||
    request.workspace !== expectedWorkspace
  ) {
    throw new Error("Request does not match the configured execution workspace or protocol version");
  }
  return Buffer.from(JSON.stringify(request));
}

export async function readRequest(expectedWorkspace) {
  const chunks = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error(`Request exceeds ${MAX_REQUEST_BYTES} bytes`);
    chunks.push(chunk);
  }
  return parseRequest(Buffer.concat(chunks), expectedWorkspace);
}

function terminateProcessTree(pid, signal) {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {}
  } else {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (systemRoot !== undefined && /^[A-Za-z]:[\\/]/u.test(systemRoot) && !systemRoot.includes("\0")) {
      try {
        const result = spawnSync(win32.join(win32.resolve(systemRoot), "System32", "taskkill.exe"), [
          "/PID", String(pid), "/T", "/F",
        ], { shell: false, stdio: "ignore", timeout: 2_000, windowsHide: true });
        if (result.error === undefined && result.status === 0) return;
      } catch {}
    }
  }
  try { process.kill(pid, signal); } catch {}
}

export async function executeRelay(argv, input, options = {}) {
  const [command, ...args] = argv;
  if (command === undefined || !isAbsolute(command)) throw new Error("Relay executable must be absolute");
  options.signal?.throwIfAborted();
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    env: {},
    stdio: "pipe",
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stopReason;
  let escalation;
  const signalChild = (signal) => {
    if (child.pid === undefined) return;
    terminateProcessTree(child.pid, signal);
  };
  const stopChild = (reason) => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    signalChild("SIGTERM");
    escalation = setTimeout(() => signalChild("SIGKILL"), 1_000);
    escalation.unref();
  };
  const onAbort = () => stopChild("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) onAbort();
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE" && error.code !== "EOF") reject(error);
    });
    child.stdout.on("data", (value) => {
      const chunk = Buffer.from(value);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_RESPONSE_BYTES) stdout.push(chunk);
      if (stdoutBytes > MAX_RESPONSE_BYTES) stopChild("overflow");
    });
    child.stderr.on("data", (value) => {
      const chunk = Buffer.from(value);
      stderrBytes += chunk.byteLength;
      const retained = Math.max(0, MAX_DIAGNOSTIC_BYTES - stderr.reduce((sum, entry) => sum + entry.byteLength, 0));
      if (retained > 0) stderr.push(chunk.subarray(0, retained));
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(input);
  let outcome;
  try {
    outcome = await completed;
  } finally {
    if (escalation !== undefined) clearTimeout(escalation);
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (stopReason === "abort") throw new Error("Executor terminated after cancellation");
  if (stdoutBytes > MAX_RESPONSE_BYTES) throw new Error(`Executor response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  if (outcome.signal !== null) throw new Error(`Executor terminated by ${outcome.signal}`);
  if (outcome.code !== 0) {
    const diagnostic = Buffer.concat(stderr).toString("utf8").replaceAll("\0", "�").trim();
    throw new Error(`Executor exited with code ${outcome.code}: ${diagnostic || "no diagnostic output"}`);
  }
  return Buffer.concat(stdout);
}

async function writeStdout(value) {
  await new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

export async function relay(argv, input) {
  const controller = new AbortController();
  const forwardSignal = () => controller.abort(new Error("Relay interrupted"));
  process.once("SIGTERM", forwardSignal);
  process.once("SIGINT", forwardSignal);
  process.once("SIGHUP", forwardSignal);
  try {
    await writeStdout(await executeRelay(argv, input, { signal: controller.signal }));
  } finally {
    process.removeListener("SIGTERM", forwardSignal);
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGHUP", forwardSignal);
  }
}

export function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message.replaceAll("\0", "�").slice(0, 4096)}\n`);
  process.exitCode = 1;
}
