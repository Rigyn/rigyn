import { defaultSecretRedactor } from "../auth/redaction.js";
import type { ToolProgress } from "../core/events.js";
import { CoalescedOutputProgress } from "../tools/progress.js";
import { commandShellArgv } from "./command-shell.js";
import { runProcess } from "./runner.js";

const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:api_?key|auth(?:orization)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
const CREDENTIAL_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/u;

export async function runShellShortcut(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
  environment: NodeJS.ProcessEnv = process.env,
  onProgress?: (progress: ToolProgress) => void,
  shellPath?: string,
  commandPrefix?: string,
): Promise<{ text: string; exitCode: number | null; signal?: NodeJS.Signals }> {
  if (command.trim() === "" || Buffer.byteLength(command) > 131_072) throw new Error("Shell shortcut command is empty or too large");
  if (commandPrefix !== undefined && (
    commandPrefix.includes("\0")
    || Buffer.byteLength(commandPrefix, "utf8") > 16 * 1_024
  )) throw new Error("Shell shortcut prefix must contain at most 16384 bytes and no NUL");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new RangeError("Shell shortcut timeout must be between 1 and 600000 ms");
  signal.throwIfAborted();
  const argv = await commandShellArgv(commandPrefix === undefined ? command : `${commandPrefix}\n${command}`, {
    environment,
    ...(shellPath === undefined ? {} : { configuredPath: shellPath }),
  });
  const childEnvironment = shellShortcutEnvironment(environment);
  const maximum = 512 * 1024;
  const progress = onProgress === undefined ? undefined : new CoalescedOutputProgress(onProgress);
  let outcome: Awaited<ReturnType<typeof runProcess>>;
  try {
    outcome = await runProcess({
      argv,
      cwd,
      env: Object.fromEntries(
        Object.entries(childEnvironment).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      inheritEnv: false,
      timeoutMs,
      outputLimitBytes: maximum,
      onOutput(stream, chunk) {
        progress?.push(stream, Buffer.from(chunk));
      },
    }, signal);
  } finally {
    progress?.close();
  }
  if (outcome.cancelled) throw signal.reason ?? new Error("Shell shortcut cancelled");
  if (outcome.timedOut) throw new Error(`Shell shortcut timed out after ${timeoutMs} ms`);
  const result = {
    exitCode: outcome.exitCode,
    ...(outcome.signal === null ? {} : { signal: outcome.signal }),
  };
  const sections = [
    `$ ${defaultSecretRedactor.redact(command)}`,
    outcome.stdout.length === 0 ? undefined : defaultSecretRedactor.redact(outcome.stdout.toString("utf8").replace(/\s+$/u, "")),
    outcome.stderr.length === 0 ? undefined : `stderr:\n${defaultSecretRedactor.redact(outcome.stderr.toString("utf8").replace(/\s+$/u, ""))}`,
    outcome.stdoutBytes > outcome.stdout.length || outcome.stderrBytes > outcome.stderr.length ? "… output truncated" : undefined,
    result.signal === undefined ? `exit ${result.exitCode ?? "unknown"}` : `signal ${result.signal}`,
  ].filter((value): value is string => value !== undefined && value !== "");
  return { text: sections.join("\n"), ...result };
}

export function shellShortcutEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENVIRONMENT_NAME.test(name) || CREDENTIAL_URL.test(value)) {
      defaultSecretRedactor.register(value);
      continue;
    }
    result[name] = value;
  }
  return result;
}
