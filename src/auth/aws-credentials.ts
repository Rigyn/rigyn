import { homedir } from "node:os";
import { join } from "node:path";

import {
  CloudAuthIoError,
  parseJsonRecord,
  readBoundedFile,
  readOptionalBoundedFile,
  requestBounded,
} from "./cloud-http.js";
import { minimalProcessEnvironment, runSafeProcess } from "./process.js";
import type { SafeProcessOptions, SafeProcessResult } from "./process.js";
import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";

const AWS_FILE_LIMIT = 1024 * 1024;
const TOKEN_FILE_LIMIT = 64 * 1024;
const DEFAULT_RESPONSE_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_METADATA_TIMEOUT_MS = 1_000;

type ProcessRunner = (options: SafeProcessOptions) => Promise<SafeProcessResult>;

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt?: number;
  accountId?: string;
  source: string;
}

export interface AwsDefaultCredentialsOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  profile?: string;
  fetch?: typeof fetch;
  processRunner?: ProcessRunner;
  timeoutMs?: number;
  metadataTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  now?: () => number;
  redactor?: SecretRedactor;
}

type IniSection = Readonly<Record<string, string>>;
type IniFile = ReadonlyMap<string, IniSection>;

interface AwsContext {
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  fetch: typeof fetch;
  processRunner: ProcessRunner;
  timeoutMs: number;
  metadataTimeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  now: () => number;
  redactor: SecretRedactor;
}

function configured(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value === "" ? undefined : value;
}

function context(options: AwsDefaultCredentialsOptions): AwsContext {
  const environment = options.environment ?? process.env;
  return {
    environment,
    homeDirectory: options.homeDirectory ?? homedir(),
    fetch: options.fetch ?? fetch,
    processRunner: options.processRunner ?? runSafeProcess,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    metadataTimeoutMs: options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now: options.now ?? Date.now,
    redactor: options.redactor ?? defaultSecretRedactor,
  };
}

function registerCredentials(credentials: AwsCredentials, redactor: SecretRedactor): AwsCredentials {
  redactor.registerAll([
    credentials.accessKeyId,
    credentials.secretAccessKey,
    credentials.sessionToken,
  ]);
  return credentials;
}

function requiredString(record: Record<string, unknown>, name: string, label: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} omitted ${name}`);
  return value;
}

function optionalString(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`AWS credential field ${name} was invalid`);
  return value;
}

function expiration(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} expiration was invalid`);
  return milliseconds;
}

function staticEnvironmentCredentials(ctx: AwsContext): AwsCredentials | undefined {
  const accessKeyId = configured(ctx.environment, "AWS_ACCESS_KEY_ID") ?? configured(ctx.environment, "AWS_ACCESS_KEY");
  const secretAccessKey =
    configured(ctx.environment, "AWS_SECRET_ACCESS_KEY") ?? configured(ctx.environment, "AWS_SECRET_KEY");
  if (accessKeyId === undefined && secretAccessKey === undefined) return undefined;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error("AWS environment credentials are incomplete");
  }
  const sessionToken = configured(ctx.environment, "AWS_SESSION_TOKEN");
  return registerCredentials(
    {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      source: "environment",
    },
    ctx.redactor,
  );
}

function parseIni(text: string, label: string): IniFile {
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | undefined;
  for (const originalLine of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = originalLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      if (name === "" || name.includes("[") || name.includes("]")) {
        throw new Error(`${label} contained an invalid section`);
      }
      current = sections.get(name) ?? {};
      sections.set(name, current);
      continue;
    }
    if (current === undefined) throw new Error(`${label} contained a setting outside a section`);
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`${label} contained an invalid setting`);
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!/^[a-z0-9_]+$/u.test(name)) throw new Error(`${label} contained an invalid setting name`);
    current[name] = line.slice(separator + 1).trim();
  }
  return sections;
}

function homePath(value: string | undefined, fallback: string, homeDirectory: string): string {
  const path = value ?? join(homeDirectory, fallback);
  if (path === "~") return homeDirectory;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homeDirectory, path.slice(2));
  return path;
}

function tokenizeProcessCommand(value: string): readonly [string, ...string[]] {
  const arguments_: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) break;
    if (quote === undefined && /\s/u.test(character)) {
      if (started) {
        arguments_.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === undefined) {
        quote = character;
        started = true;
        continue;
      }
      if (quote === character) {
        quote = undefined;
        continue;
      }
    }
    if (character === "\\") {
      const next = value[index + 1];
      if (next !== undefined && (next === quote || next === "\\" || (quote === undefined && /\s/u.test(next)))) {
        current += next;
        started = true;
        index += 1;
        continue;
      }
    }
    current += character;
    started = true;
  }
  if (quote !== undefined) throw new Error("AWS credential_process contained an unclosed quote");
  if (started) arguments_.push(current);
  if (arguments_.length === 0 || arguments_[0] === undefined || arguments_[0] === "") {
    throw new Error("AWS credential_process was empty");
  }
  return arguments_ as [string, ...string[]];
}

async function processCredentials(
  command: string,
  profile: string,
  ctx: AwsContext,
): Promise<AwsCredentials> {
  const [program, ...args] = tokenizeProcessCommand(command);
  const result = await ctx.processRunner({
    command: program,
    args,
    environment: minimalProcessEnvironment({ AWS_PROFILE: profile }, ctx.environment),
    timeoutMs: ctx.timeoutMs,
    maxOutputBytes: ctx.maxResponseBytes,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    redactor: ctx.redactor,
  });
  if (result.exitCode !== 0) throw new Error(`AWS credential_process exited with code ${result.exitCode}`);
  const record = parseJsonRecord(result.stdout, "AWS credential_process");
  if (record.Version !== 1) throw new Error("AWS credential_process returned an unsupported version");
  const expiresAt = expiration(optionalString(record, "Expiration"), "AWS credential_process");
  if (expiresAt !== undefined && expiresAt <= ctx.now()) {
    throw new Error("AWS credential_process returned expired credentials");
  }
  const sessionToken = optionalString(record, "SessionToken");
  const accountId = optionalString(record, "AccountId");
  return registerCredentials(
    {
      accessKeyId: requiredString(record, "AccessKeyId", "AWS credential_process"),
      secretAccessKey: requiredString(record, "SecretAccessKey", "AWS credential_process"),
      ...(sessionToken === undefined ? {} : { sessionToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(accountId === undefined ? {} : { accountId }),
      source: `profile:${profile}:credential_process`,
    },
    ctx.redactor,
  );
}

function xmlValue(text: string, name: string): string | undefined {
  const expression = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`,
    "u",
  );
  const match = expression.exec(text);
  if (match?.[1] === undefined) return undefined;
  return match[1]
    .replace(/&#x([0-9a-f]+);/giu, (_whole, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/gu, (_whole, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function stsEndpoint(region: string): URL {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(region) || region.length > 64) {
    throw new Error("AWS region was invalid");
  }
  const suffix = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return new URL(`https://sts.${region}.${suffix}/`);
}

async function webIdentityCredentials(
  settings: IniSection,
  source: string,
  ctx: AwsContext,
): Promise<AwsCredentials> {
  const roleArn = settings.role_arn;
  const tokenPath = settings.web_identity_token_file;
  if (roleArn === undefined || tokenPath === undefined) {
    throw new Error("AWS web identity configuration is incomplete");
  }
  const roleSessionName = settings.role_session_name ?? `rigyn-${process.pid}`;
  if (!/^[\w+=,.@-]{2,64}$/u.test(roleSessionName)) throw new Error("AWS role session name was invalid");
  const token = (await readBoundedFile(tokenPath, TOKEN_FILE_LIMIT, "AWS web identity token file")).trim();
  if (token.length < 4 || token.length > 20_000) throw new Error("AWS web identity token was invalid");
  ctx.redactor.register(token);

  const parameters = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: roleSessionName,
    WebIdentityToken: token,
  });
  if (settings.duration_seconds !== undefined) {
    const duration = Number(settings.duration_seconds);
    if (!Number.isInteger(duration) || duration < 900 || duration > 43_200) {
      throw new Error("AWS web identity duration_seconds was invalid");
    }
    parameters.set("DurationSeconds", String(duration));
  }
  const region = settings.region ?? configured(ctx.environment, "AWS_REGION") ?? configured(ctx.environment, "AWS_DEFAULT_REGION") ?? "us-east-1";
  const response = await requestBounded(
    stsEndpoint(region),
    {
      method: "POST",
      headers: {
        accept: "application/xml",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: parameters,
    },
    {
      fetch: ctx.fetch,
      timeoutMs: ctx.timeoutMs,
      maxResponseBytes: ctx.maxResponseBytes,
      label: "AWS STS web identity",
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    },
  );
  if (!response.ok) {
    const rawCode = xmlValue(response.text, "Code");
    const code = rawCode !== undefined && /^[A-Za-z0-9._-]{1,128}$/u.test(rawCode) ? ` ${rawCode}` : "";
    throw new Error(`AWS STS web identity failed (${response.status}${code})`);
  }
  const accessKeyId = xmlValue(response.text, "AccessKeyId");
  const secretAccessKey = xmlValue(response.text, "SecretAccessKey");
  const sessionToken = xmlValue(response.text, "SessionToken");
  const expiresAt = expiration(xmlValue(response.text, "Expiration"), "AWS STS web identity");
  if (
    accessKeyId === undefined ||
    accessKeyId === "" ||
    secretAccessKey === undefined ||
    secretAccessKey === "" ||
    sessionToken === undefined ||
    sessionToken === "" ||
    expiresAt === undefined
  ) {
    throw new Error("AWS STS web identity response was malformed");
  }
  if (expiresAt <= ctx.now()) throw new Error("AWS STS web identity returned expired credentials");
  return registerCredentials(
    { accessKeyId, secretAccessKey, sessionToken, expiresAt, source },
    ctx.redactor,
  );
}

async function profileCredentials(
  profile: string,
  ctx: AwsContext,
): Promise<AwsCredentials | undefined> {
  const credentialsPath = homePath(
    configured(ctx.environment, "AWS_SHARED_CREDENTIALS_FILE"),
    join(".aws", "credentials"),
    ctx.homeDirectory,
  );
  const configPath = homePath(
    configured(ctx.environment, "AWS_CONFIG_FILE"),
    join(".aws", "config"),
    ctx.homeDirectory,
  );
  const [credentialsText, configText] = await Promise.all([
    readOptionalBoundedFile(credentialsPath, AWS_FILE_LIMIT, "AWS shared credentials file"),
    readOptionalBoundedFile(configPath, AWS_FILE_LIMIT, "AWS shared config file"),
  ]);
  const credentialSection = credentialsText === undefined ? undefined : parseIni(credentialsText, "AWS shared credentials file").get(profile);
  const configName = profile === "default" ? "default" : `profile ${profile}`;
  const configSection = configText === undefined ? undefined : parseIni(configText, "AWS shared config file").get(configName);
  if (credentialSection === undefined && configSection === undefined) return undefined;
  const settings: Record<string, string> = { ...configSection, ...credentialSection };

  const accessKeyId = settings.aws_access_key_id;
  const secretAccessKey = settings.aws_secret_access_key;
  if (accessKeyId !== undefined || secretAccessKey !== undefined) {
    if (accessKeyId === undefined || accessKeyId === "" || secretAccessKey === undefined || secretAccessKey === "") {
      throw new Error(`AWS profile ${profile} contains incomplete static credentials`);
    }
    return registerCredentials(
      {
        accessKeyId,
        secretAccessKey,
        ...(settings.aws_session_token === undefined || settings.aws_session_token === ""
          ? {}
          : { sessionToken: settings.aws_session_token }),
        source: `profile:${profile}:static`,
      },
      ctx.redactor,
    );
  }
  if (settings.credential_process !== undefined) {
    return processCredentials(settings.credential_process, profile, ctx);
  }
  if (settings.web_identity_token_file !== undefined || settings.role_arn !== undefined) {
    return webIdentityCredentials(settings, `profile:${profile}:web_identity`, ctx);
  }
  if (Object.keys(settings).some((name) => name === "sso_session" || name.startsWith("sso_"))) {
    throw new Error("AWS IAM Identity Center profiles require an AWS SDK or AWS CLI credential_process");
  }
  if (settings.source_profile !== undefined || settings.credential_source !== undefined) {
    throw new Error("AWS source-profile role assumption is not supported without SigV4 role chaining");
  }
  return undefined;
}

function environmentWebIdentitySettings(ctx: AwsContext): IniSection | undefined {
  const roleArn = configured(ctx.environment, "AWS_ROLE_ARN");
  const tokenPath = configured(ctx.environment, "AWS_WEB_IDENTITY_TOKEN_FILE");
  if (roleArn === undefined && tokenPath === undefined) return undefined;
  const roleSessionName = configured(ctx.environment, "AWS_ROLE_SESSION_NAME");
  const region = configured(ctx.environment, "AWS_REGION");
  return {
    ...(roleArn === undefined ? {} : { role_arn: roleArn }),
    ...(tokenPath === undefined ? {} : { web_identity_token_file: tokenPath }),
    ...(roleSessionName === undefined ? {} : { role_session_name: roleSessionName }),
    ...(region === undefined ? {} : { region }),
  };
}

function parseMetadataCredentials(
  text: string,
  source: string,
  ctx: AwsContext,
): AwsCredentials {
  const record = parseJsonRecord(text, source);
  if (record.Code !== undefined && record.Code !== "Success") throw new Error(`${source} did not return success`);
  const expiresAt = expiration(optionalString(record, "Expiration"), source);
  if (expiresAt !== undefined && expiresAt <= ctx.now()) throw new Error(`${source} returned expired credentials`);
  const sessionToken = optionalString(record, "Token");
  const accountId = optionalString(record, "AccountId");
  return registerCredentials(
    {
      accessKeyId: requiredString(record, "AccessKeyId", source),
      secretAccessKey: requiredString(record, "SecretAccessKey", source),
      ...(sessionToken === undefined ? {} : { sessionToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(accountId === undefined ? {} : { accountId }),
      source,
    },
    ctx.redactor,
  );
}

function containerEndpoint(ctx: AwsContext): URL | undefined {
  const relative = configured(ctx.environment, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI");
  if (relative !== undefined) {
    if (!relative.startsWith("/") || relative.startsWith("//")) {
      throw new Error("AWS container relative credential URI was invalid");
    }
    const endpoint = new URL(relative, "http://169.254.170.2");
    if (endpoint.origin !== "http://169.254.170.2" || endpoint.username !== "" || endpoint.password !== "") {
      throw new Error("AWS container relative credential URI was invalid");
    }
    return endpoint;
  }
  const full = configured(ctx.environment, "AWS_CONTAINER_CREDENTIALS_FULL_URI");
  if (full === undefined) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(full);
  } catch {
    throw new Error("AWS container full credential URI was invalid");
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    throw new Error("AWS container credential URI contains embedded credentials");
  }
  const allowedHttpHosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "169.254.170.2",
    "169.254.170.23",
    "fd00:ec2::23",
  ]);
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && allowedHttpHosts.has(hostname))) {
    throw new Error("AWS container credential URI must use HTTPS or an AWS/loopback metadata host");
  }
  return endpoint;
}

async function containerCredentials(ctx: AwsContext): Promise<AwsCredentials | undefined> {
  const endpoint = containerEndpoint(ctx);
  if (endpoint === undefined) return undefined;
  const tokenFile = configured(ctx.environment, "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE");
  const token = tokenFile === undefined
    ? configured(ctx.environment, "AWS_CONTAINER_AUTHORIZATION_TOKEN")
    : (await readBoundedFile(tokenFile, TOKEN_FILE_LIMIT, "AWS container authorization token file")).trim();
  if (tokenFile !== undefined && token === "") throw new Error("AWS container authorization token file was empty");
  ctx.redactor.register(token);
  const response = await requestBounded(
    endpoint,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(token === undefined ? {} : { authorization: token }),
      },
    },
    {
      fetch: ctx.fetch,
      timeoutMs: ctx.metadataTimeoutMs,
      maxResponseBytes: ctx.maxResponseBytes,
      label: "AWS container credentials",
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    },
  );
  if (!response.ok) throw new Error(`AWS container credential request failed (${response.status})`);
  return parseMetadataCredentials(response.text, "container", ctx);
}

async function instanceMetadataCredentials(ctx: AwsContext): Promise<AwsCredentials | undefined> {
  if (configured(ctx.environment, "AWS_EC2_METADATA_DISABLED")?.toLowerCase() === "true") return undefined;
  let tokenResponse;
  try {
    tokenResponse = await requestBounded(
      "http://169.254.169.254/latest/api/token",
      {
        method: "PUT",
        headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
      },
      {
        fetch: ctx.fetch,
        timeoutMs: ctx.metadataTimeoutMs,
        maxResponseBytes: 16 * 1024,
        label: "AWS IMDSv2 token",
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
  } catch (error) {
    if (error instanceof CloudAuthIoError) return undefined;
    throw error;
  }
  if (!tokenResponse.ok) return undefined;
  const token = tokenResponse.text.trim();
  if (token === "") return undefined;
  ctx.redactor.register(token);
  const headers = { "x-aws-ec2-metadata-token": token };
  let roleResponse;
  try {
    roleResponse = await requestBounded(
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      { method: "GET", headers },
      {
        fetch: ctx.fetch,
        timeoutMs: ctx.metadataTimeoutMs,
        maxResponseBytes: 16 * 1024,
        label: "AWS IMDSv2 role",
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
  } catch (error) {
    if (error instanceof CloudAuthIoError) return undefined;
    throw error;
  }
  if (!roleResponse.ok) return undefined;
  const roleName = roleResponse.text.trim().split(/\r?\n/u)[0];
  if (roleName === undefined || !/^[\w+=,.@-]{1,128}$/u.test(roleName)) {
    throw new Error("AWS IMDSv2 returned an invalid role name");
  }
  let credentialsResponse;
  try {
    credentialsResponse = await requestBounded(
      `http://169.254.169.254/latest/meta-data/iam/security-credentials/${encodeURIComponent(roleName)}`,
      { method: "GET", headers },
      {
        fetch: ctx.fetch,
        timeoutMs: ctx.metadataTimeoutMs,
        maxResponseBytes: ctx.maxResponseBytes,
        label: "AWS IMDSv2 credentials",
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
  } catch (error) {
    if (error instanceof CloudAuthIoError) return undefined;
    throw error;
  }
  if (!credentialsResponse.ok) return undefined;
  return parseMetadataCredentials(credentialsResponse.text, "imds_v2", ctx);
}

export async function resolveAwsDefaultCredentials(
  options: AwsDefaultCredentialsOptions = {},
): Promise<AwsCredentials | undefined> {
  const ctx = context(options);
  ctx.signal?.throwIfAborted();

  const environmentCredentials = staticEnvironmentCredentials(ctx);
  if (environmentCredentials !== undefined) return environmentCredentials;

  const profile = options.profile ?? configured(ctx.environment, "AWS_PROFILE") ?? configured(ctx.environment, "AWS_DEFAULT_PROFILE") ?? "default";
  const fromProfile = await profileCredentials(profile, ctx);
  if (fromProfile !== undefined) return fromProfile;

  const webIdentity = environmentWebIdentitySettings(ctx);
  if (webIdentity !== undefined) {
    return webIdentityCredentials(webIdentity, "environment:web_identity", ctx);
  }
  const fromContainer = await containerCredentials(ctx);
  if (fromContainer !== undefined) return fromContainer;
  return instanceMetadataCredentials(ctx);
}
