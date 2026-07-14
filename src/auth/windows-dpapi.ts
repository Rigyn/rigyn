import { join } from "node:path";

import {
  minimalProcessEnvironment,
  runSafeProcess,
  type SafeProcessOptions,
  type SafeProcessResult,
} from "./process.js";
import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";

const PREFIX = "dpapi:v1:";
const ENTROPY = "rigyn-credential-key-v1";
const INPUT_ENVIRONMENT_NAME = "RIGYN_DPAPI_INPUT";
const DPAPI_TIMEOUT_MS = 60_000;
const PROTECT_SCRIPT = [
  `$source=$env:${INPUT_ENVIRONMENT_NAME};Remove-Item Env:${INPUT_ENVIRONMENT_NAME}`,
  "Add-Type -AssemblyName System.Security",
  "$data=[Convert]::FromBase64String($source)",
  `$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
  "$protected=[Security.Cryptography.ProtectedData]::Protect($data,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($protected))",
].join(";");
const UNPROTECT_SCRIPT = [
  `$source=$env:${INPUT_ENVIRONMENT_NAME};Remove-Item Env:${INPUT_ENVIRONMENT_NAME}`,
  "Add-Type -AssemblyName System.Security",
  "$data=[Convert]::FromBase64String($source)",
  `$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect($data,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($plain))",
].join(";");

export type WindowsDpapiRunner = (options: SafeProcessOptions) => Promise<SafeProcessResult>;

export interface WindowsDpapiOptions {
  runner?: WindowsDpapiRunner;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  redactor?: SecretRedactor;
}

function command(options: WindowsDpapiOptions): string {
  if (options.command !== undefined) return options.command;
  const root = options.environment?.SystemRoot ?? options.environment?.WINDIR ?? process.env.SystemRoot ?? process.env.WINDIR;
  return root === undefined
    ? "powershell.exe"
    : join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function canonicalBase64(value: string, label: string): Buffer {
  const selected = value.trim();
  if (selected === "" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(selected) || selected.length > 16 * 1024) {
    throw new Error(`${label} is not bounded base64`);
  }
  const decoded = Buffer.from(selected, "base64");
  if (decoded.toString("base64") !== selected) throw new Error(`${label} is not canonical base64`);
  return decoded;
}

async function invoke(
  script: string,
  input: string,
  options: WindowsDpapiOptions,
): Promise<string> {
  const redactor = options.redactor ?? defaultSecretRedactor;
  redactor.register(input);
  const environment = minimalProcessEnvironment({ [INPUT_ENVIRONMENT_NAME]: input }, {
    ...process.env,
    ...options.environment,
  });
  const result = await (options.runner ?? runSafeProcess)({
    command: command(options),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    environment,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: DPAPI_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024,
    redactor,
  });
  if (result.exitCode !== 0) {
    const detail = redactor.redact(result.stderr).replace(/[\r\n\t]+/gu, " ").trim();
    throw new Error(detail === "" ? "Windows DPAPI command failed" : `Windows DPAPI command failed: ${detail}`);
  }
  return result.stdout.trim();
}

export function isWindowsDpapiEnvelope(value: string): boolean {
  return value.startsWith(PREFIX);
}

export async function protectWindowsCredentialKey(
  key: Uint8Array,
  options: WindowsDpapiOptions = {},
): Promise<string> {
  if (key.byteLength !== 32) throw new Error("Windows credential key must contain exactly 32 bytes");
  const protectedValue = await invoke(PROTECT_SCRIPT, Buffer.from(key).toString("base64"), options);
  const decoded = canonicalBase64(protectedValue, "Windows DPAPI result");
  if (decoded.byteLength < 32 || decoded.byteLength > 8 * 1024) throw new Error("Windows DPAPI result has an invalid size");
  return `${PREFIX}${protectedValue}`;
}

export async function unprotectWindowsCredentialKey(
  envelope: string,
  options: WindowsDpapiOptions = {},
): Promise<Buffer> {
  if (!isWindowsDpapiEnvelope(envelope)) throw new Error("Windows credential key is not a supported DPAPI envelope");
  const protectedValue = envelope.slice(PREFIX.length);
  const protectedBytes = canonicalBase64(protectedValue, "Windows DPAPI envelope");
  if (protectedBytes.byteLength < 32 || protectedBytes.byteLength > 8 * 1024) {
    throw new Error("Windows DPAPI envelope has an invalid size");
  }
  const plaintext = canonicalBase64(
    await invoke(UNPROTECT_SCRIPT, protectedValue, options),
    "Windows DPAPI plaintext",
  );
  if (plaintext.byteLength !== 32) throw new Error("Windows DPAPI plaintext is not a 32-byte credential key");
  defaultSecretRedactor.register(plaintext.toString("base64url"));
  return plaintext;
}
