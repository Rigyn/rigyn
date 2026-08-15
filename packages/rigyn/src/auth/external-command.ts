import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";
import { minimalProcessEnvironment, runSafeProcess } from "./process.js";
import type { ApiKeyCredential, AuthProviderId, BearerCredential } from "./types.js";

export interface ExternalCommandOptions {
  provider: AuthProviderId;
  argv: readonly [string, ...string[]];
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  redactor?: SecretRedactor;
}

interface CommandApiKeyResult {
  type: "api_key";
  apiKey: string;
  accountId?: string;
}

interface CommandBearerResult {
  type: "bearer";
  accessToken: string;
  expiresAt?: number;
  accountId?: string;
  subject?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function parseResult(value: unknown): CommandApiKeyResult | CommandBearerResult {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("External credential command returned an invalid object");
  }
  if (
    value.type === "api_key" &&
    typeof value.apiKey === "string" &&
    value.apiKey.length > 0 &&
    optionalString(value.accountId)
  ) {
    return value as unknown as CommandApiKeyResult;
  }
  if (
    value.type === "bearer" &&
    typeof value.accessToken === "string" &&
    value.accessToken.length > 0 &&
    optionalString(value.accountId) &&
    optionalString(value.subject) &&
    (value.expiresAt === undefined ||
      (typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)))
  ) {
    return value as unknown as CommandBearerResult;
  }
  throw new Error("External credential command returned an unsupported credential");
}

export async function resolveExternalCommandCredential(
  options: ExternalCommandOptions,
): Promise<ApiKeyCredential | BearerCredential> {
  const [command, ...args] = options.argv;
  const redactor = options.redactor ?? defaultSecretRedactor;
  const result = await runSafeProcess({
    command,
    args,
    environment: minimalProcessEnvironment(options.environment),
    timeoutMs: options.timeoutMs ?? 10_000,
    maxOutputBytes: options.maxOutputBytes ?? 16 * 1024,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    redactor,
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      detail.length === 0
        ? `External credential command exited with ${result.exitCode}`
        : `External credential command failed: ${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("External credential command did not return JSON", { cause: error });
  }
  const credential = parseResult(parsed);
  if (credential.type === "api_key") {
    redactor.register(credential.apiKey);
    return {
      kind: "api_key",
      provider: options.provider,
      apiKey: credential.apiKey,
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    };
  }
  redactor.register(credential.accessToken);
  return {
    kind: "bearer",
    provider: options.provider,
    accessToken: credential.accessToken,
    ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    ...(credential.subject === undefined ? {} : { subject: credential.subject }),
  };
}
