import { defaultSecretRedactor, type SecretRedactor } from "../auth/redaction.js";
import { runSafeProcess } from "../auth/process.js";
import { commandShellInvocation } from "../process/command-shell.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const MAX_RESOLVED_VALUE_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface ProviderConfigValueContext {
  env(name: string): Promise<string | undefined>;
  environment?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  redactor?: SecretRedactor;
  shellPath?: string;
}

export function providerConfigValueUsesCommand(value: string): boolean {
  return value.startsWith("!");
}

async function interpolateEnvironment(
  value: string,
  context: ProviderConfigValueContext,
): Promise<string | undefined> {
  let result = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "$") {
      result += value[index];
      index += 1;
      continue;
    }
    const next = value[index + 1];
    if (next === "$" || next === "!") {
      result += next;
      index += 2;
      continue;
    }
    let name: string | undefined;
    let consumed = 1;
    if (next === "{") {
      const end = value.indexOf("}", index + 2);
      const candidate = end < 0 ? "" : value.slice(index + 2, end);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(candidate)) {
        name = candidate;
        consumed = end - index + 1;
      }
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(value.slice(index + 1));
      if (match !== null) {
        name = match[0];
        consumed = name.length + 1;
      }
    }
    if (name === undefined) {
      result += "$";
      index += 1;
      continue;
    }
    const replacement = await context.env(name);
    if (replacement === undefined) return undefined;
    result += replacement;
    index += consumed;
    if (Buffer.byteLength(result, "utf8") > MAX_RESOLVED_VALUE_BYTES) {
      throw new Error("Resolved provider configuration value is too large");
    }
  }
  return result;
}

async function executeCommand(
  command: string,
  context: ProviderConfigValueContext,
): Promise<string> {
  if (command.trim() === "") throw new Error("Provider configuration command must not be empty");
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const dynamicLibraryInjectionVariable = ["LD", "PRE", "LOAD"].join("_");
  const blocked = new Set([
    "NODE_OPTIONS",
    "NODE_PATH",
    dynamicLibraryInjectionVariable,
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
  ]);
  for (const [name, value] of Object.entries(context.environment ?? {})) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      blocked.has(name.toLocaleUpperCase("en-US")) ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > MAX_RESOLVED_VALUE_BYTES
    ) {
      throw new Error("Provider configuration command environment is invalid");
    }
    environment[name] = value;
  }
  const invocation = await commandShellInvocation(command, {
    environment,
    ...(context.shellPath === undefined ? {} : { configuredPath: context.shellPath }),
  });
  const [shell, ...args] = invocation.argv;
  let result;
  try {
    result = await runSafeProcess({
      command: shell,
      args,
      ...(invocation.stdin === undefined ? {} : { input: invocation.stdin }),
      environment,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      redactor: context.redactor ?? defaultSecretRedactor,
    });
  } catch (error) {
    if (context.signal?.aborted === true) {
      throw new DOMException("Provider configuration command aborted", "AbortError");
    }
    throw new Error("Provider configuration command failed", { cause: error });
  }
  if (result.exitCode !== 0) throw new Error("Provider configuration command failed");
  const value = result.stdout.trim();
  if (
    value === "" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_RESOLVED_VALUE_BYTES
  ) {
    throw new Error("Provider configuration command returned an invalid value");
  }
  return value;
}

/**
 * Resolves one provider configuration value without recursive expansion.
 * A leading `!` is executable only when it is present in the original value.
 */
export async function resolveProviderConfigValue(
  value: string,
  context: ProviderConfigValueContext,
): Promise<string | undefined> {
  context.signal?.throwIfAborted();
  const resolved = providerConfigValueUsesCommand(value)
    ? await executeCommand(value.slice(1), context)
    : await interpolateEnvironment(value, context);
  context.signal?.throwIfAborted();
  if (resolved !== undefined && Buffer.byteLength(resolved, "utf8") > MAX_RESOLVED_VALUE_BYTES) {
    throw new Error("Resolved provider configuration value is too large");
  }
  if (resolved?.includes("\0") === true) throw new Error("Resolved provider configuration value is invalid");
  return resolved;
}
