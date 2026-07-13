import {
  CloudAuthIoError,
  isLoopbackHost,
  parseJsonRecord,
  readBoundedFile,
  requestBounded,
} from "./cloud-http.js";
import { minimalProcessEnvironment, runSafeProcess } from "./process.js";
import type { SafeProcessOptions, SafeProcessResult } from "./process.js";
import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";

const DEFAULT_SCOPE = "https://cognitiveservices.azure.com/.default";
const DEFAULT_RESPONSE_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_METADATA_TIMEOUT_MS = 1_000;
const FEDERATED_TOKEN_LIMIT = 64 * 1024;

type ProcessRunner = (options: SafeProcessOptions) => Promise<SafeProcessResult>;

export interface AzureAccessToken {
  accessToken: string;
  expiresAt: number;
  tokenType: "Bearer";
  source: string;
  tenantId?: string;
  clientId?: string;
}

export interface AzureDefaultCredentialOptions {
  environment?: NodeJS.ProcessEnv;
  scope?: string;
  resource?: string;
  fetch?: typeof fetch;
  processRunner?: ProcessRunner;
  azureCliPath?: string;
  allowAzureCli?: boolean;
  timeoutMs?: number;
  metadataTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  now?: () => number;
  redactor?: SecretRedactor;
}

interface AzureContext {
  environment: NodeJS.ProcessEnv;
  scope: string;
  resource: string;
  fetch: typeof fetch;
  processRunner: ProcessRunner;
  azureCliPath: string;
  allowAzureCli: boolean;
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

function resourceFromScope(scope: string): string {
  if (!scope.endsWith("/.default") || /\s/u.test(scope)) {
    throw new TypeError("Azure managed identity requires one scope ending in /.default");
  }
  return scope.slice(0, -"/.default".length);
}

function context(options: AzureDefaultCredentialOptions): AzureContext {
  const scope = options.scope ?? DEFAULT_SCOPE;
  const resource = options.resource ?? resourceFromScope(scope);
  if (scope === "" || /\s/u.test(scope) || resource === "") {
    throw new TypeError("Azure scope and resource must be non-empty single values");
  }
  return {
    environment: options.environment ?? process.env,
    scope,
    resource,
    fetch: options.fetch ?? fetch,
    processRunner: options.processRunner ?? runSafeProcess,
    azureCliPath: options.azureCliPath ?? "az",
    allowAzureCli: options.allowAzureCli ?? true,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    metadataTimeoutMs: options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now: options.now ?? Date.now,
    redactor: options.redactor ?? defaultSecretRedactor,
  };
}

function requiredString(record: Record<string, unknown>, name: string, label: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} omitted ${name}`);
  return value;
}

function optionalString(record: Record<string, unknown>, name: string, label: string): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} contained an invalid ${name}`);
  return value;
}

function registerToken(token: AzureAccessToken, redactor: SecretRedactor): AzureAccessToken {
  redactor.register(token.accessToken);
  return token;
}

function relativeExpiration(record: Record<string, unknown>, label: string, now: number): number {
  const raw = record.expires_in;
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
    throw new Error(`${label} returned an invalid expires_in`);
  }
  return now + seconds * 1000;
}

function absoluteExpiration(record: Record<string, unknown>, label: string, now: number): number {
  const raw = record.expires_on ?? record.expiresOn;
  let milliseconds = Number.NaN;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    milliseconds = raw < 10_000_000_000 ? raw * 1000 : raw;
  } else if (typeof raw === "string" && raw !== "") {
    const numeric = Number(raw);
    milliseconds = Number.isFinite(numeric)
      ? numeric < 10_000_000_000
        ? numeric * 1000
        : numeric
      : Date.parse(raw);
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= now) {
    throw new Error(`${label} returned an invalid expiration`);
  }
  return milliseconds;
}

function authorityHost(environment: NodeJS.ProcessEnv): URL {
  const value = configured(environment, "AZURE_AUTHORITY_HOST") ?? "https://login.microsoftonline.com";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Azure authority host was invalid");
  }
  const knownHosts = new Set([
    "login.microsoftonline.com",
    "login.microsoftonline.us",
    "login.chinacloudapi.cn",
    "login.microsoftonline.de",
  ]);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== "" ||
    !knownHosts.has(url.hostname)
  ) {
    throw new Error("Azure authority host must be a known Microsoft Entra cloud endpoint");
  }
  return url;
}

function tokenEndpoint(environment: NodeJS.ProcessEnv, tenantId: string): URL {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(tenantId)) throw new Error("Azure tenant ID was invalid");
  return new URL(`/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, authorityHost(environment));
}

async function entraToken(
  tenantId: string,
  clientId: string,
  fields: Readonly<Record<string, string>>,
  source: string,
  ctx: AzureContext,
): Promise<AzureAccessToken> {
  const response = await requestBounded(
    tokenEndpoint(ctx.environment, tenantId),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        scope: ctx.scope,
        ...fields,
      }),
    },
    {
      fetch: ctx.fetch,
      timeoutMs: ctx.timeoutMs,
      maxResponseBytes: ctx.maxResponseBytes,
      label: "Microsoft Entra token",
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    },
  );
  const record = parseJsonRecord(response.text, "Microsoft Entra token");
  if (!response.ok) {
    const rawCode = record.error;
    const code = typeof rawCode === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(rawCode) ? ` ${rawCode}` : "";
    throw new Error(`Microsoft Entra token request failed (${response.status}${code})`);
  }
  const accessToken = requiredString(record, "access_token", "Microsoft Entra token");
  return registerToken(
    {
      accessToken,
      expiresAt: relativeExpiration(record, "Microsoft Entra token", ctx.now()),
      tokenType: "Bearer",
      source,
      tenantId,
      clientId,
    },
    ctx.redactor,
  );
}

async function environmentCredential(ctx: AzureContext): Promise<AzureAccessToken | undefined> {
  const tenantId = configured(ctx.environment, "AZURE_TENANT_ID");
  const clientId = configured(ctx.environment, "AZURE_CLIENT_ID");
  const clientSecret = configured(ctx.environment, "AZURE_CLIENT_SECRET");
  if (clientSecret === undefined) return undefined;
  if (tenantId === undefined || clientId === undefined) {
    throw new Error("Azure service-principal environment configuration is incomplete");
  }
  ctx.redactor.register(clientSecret);
  return entraToken(tenantId, clientId, { client_secret: clientSecret }, "environment:client_secret", ctx);
}

async function workloadIdentityCredential(ctx: AzureContext): Promise<AzureAccessToken | undefined> {
  const tokenPath = configured(ctx.environment, "AZURE_FEDERATED_TOKEN_FILE");
  if (tokenPath === undefined) return undefined;
  const tenantId = configured(ctx.environment, "AZURE_TENANT_ID");
  const clientId = configured(ctx.environment, "AZURE_CLIENT_ID");
  if (tenantId === undefined || clientId === undefined) {
    throw new Error("Azure workload-identity environment configuration is incomplete");
  }
  const assertion = (await readBoundedFile(tokenPath, FEDERATED_TOKEN_LIMIT, "Azure federated token file")).trim();
  if (assertion === "") throw new Error("Azure federated token file was empty");
  ctx.redactor.register(assertion);
  return entraToken(
    tenantId,
    clientId,
    {
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    },
    "environment:workload_identity",
    ctx,
  );
}

function managedIdentityEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Azure App Service identity endpoint was invalid");
  }
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    !isLoopbackHost(hostname)
  ) {
    throw new Error("Azure App Service identity endpoint must be a loopback HTTP(S) URL");
  }
  return endpoint;
}

function parseManagedToken(
  record: Record<string, unknown>,
  source: string,
  ctx: AzureContext,
): AzureAccessToken {
  const accessToken = requiredString(record, "access_token", "Azure managed identity");
  const clientId = optionalString(record, "client_id", "Azure managed identity");
  return registerToken(
    {
      accessToken,
      expiresAt: absoluteExpiration(record, "Azure managed identity", ctx.now()),
      tokenType: "Bearer",
      source,
      ...(clientId === undefined ? {} : { clientId }),
    },
    ctx.redactor,
  );
}

async function appServiceManagedIdentity(ctx: AzureContext): Promise<AzureAccessToken | undefined> {
  const endpointValue = configured(ctx.environment, "IDENTITY_ENDPOINT");
  const identityHeader = configured(ctx.environment, "IDENTITY_HEADER");
  if (endpointValue === undefined && identityHeader === undefined) return undefined;
  if (endpointValue === undefined || identityHeader === undefined) {
    throw new Error("Azure App Service managed-identity environment is incomplete");
  }
  ctx.redactor.register(identityHeader);
  const endpoint = managedIdentityEndpoint(endpointValue);
  endpoint.searchParams.set("api-version", "2019-08-01");
  endpoint.searchParams.set("resource", ctx.resource);
  const clientId = configured(ctx.environment, "AZURE_CLIENT_ID");
  if (clientId !== undefined) endpoint.searchParams.set("client_id", clientId);
  const response = await requestBounded(
    endpoint,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-identity-header": identityHeader,
      },
    },
    {
      fetch: ctx.fetch,
      timeoutMs: ctx.metadataTimeoutMs,
      maxResponseBytes: ctx.maxResponseBytes,
      label: "Azure App Service managed identity",
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    },
  );
  if (!response.ok) throw new Error(`Azure App Service managed-identity request failed (${response.status})`);
  return parseManagedToken(parseJsonRecord(response.text, "Azure App Service managed identity"), "app_service_managed_identity", ctx);
}

async function imdsManagedIdentity(ctx: AzureContext): Promise<AzureAccessToken | undefined> {
  const endpoint = new URL("http://169.254.169.254/metadata/identity/oauth2/token");
  endpoint.searchParams.set("api-version", "2018-02-01");
  endpoint.searchParams.set("resource", ctx.resource);
  const clientId = configured(ctx.environment, "AZURE_CLIENT_ID");
  if (clientId !== undefined) endpoint.searchParams.set("client_id", clientId);
  let response;
  try {
    response = await requestBounded(
      endpoint,
      { method: "GET", headers: { accept: "application/json", metadata: "true" } },
      {
        fetch: ctx.fetch,
        timeoutMs: ctx.metadataTimeoutMs,
        maxResponseBytes: ctx.maxResponseBytes,
        label: "Azure IMDS managed identity",
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
  } catch (error) {
    if (error instanceof CloudAuthIoError) return undefined;
    throw error;
  }
  if (!response.ok) return undefined;
  return parseManagedToken(parseJsonRecord(response.text, "Azure IMDS managed identity"), "imds_managed_identity", ctx);
}

async function azureCliCredential(ctx: AzureContext): Promise<AzureAccessToken | undefined> {
  if (!ctx.allowAzureCli) return undefined;
  const azureConfigDirectory = configured(ctx.environment, "AZURE_CONFIG_DIR");
  let result: SafeProcessResult;
  try {
    result = await ctx.processRunner({
      command: ctx.azureCliPath,
      args: [
        "account",
        "get-access-token",
        "--scope",
        ctx.scope,
        "--output",
        "json",
        "--only-show-errors",
      ],
      environment: minimalProcessEnvironment(
        azureConfigDirectory === undefined ? {} : { AZURE_CONFIG_DIR: azureConfigDirectory },
        ctx.environment,
      ),
      timeoutMs: ctx.timeoutMs,
      maxOutputBytes: ctx.maxResponseBytes,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      redactor: ctx.redactor,
    });
  } catch {
    ctx.signal?.throwIfAborted();
    return undefined;
  }
  if (result.exitCode !== 0) return undefined;
  const record = parseJsonRecord(result.stdout, "Azure CLI access token");
  const accessToken = requiredString(record, "accessToken", "Azure CLI access token");
  const tenantId = optionalString(record, "tenant", "Azure CLI access token");
  return registerToken(
    {
      accessToken,
      expiresAt: absoluteExpiration(record, "Azure CLI access token", ctx.now()),
      tokenType: "Bearer",
      source: "azure_cli",
      ...(tenantId === undefined ? {} : { tenantId }),
    },
    ctx.redactor,
  );
}

export async function resolveAzureDefaultCredential(
  options: AzureDefaultCredentialOptions = {},
): Promise<AzureAccessToken | undefined> {
  const ctx = context(options);
  ctx.signal?.throwIfAborted();

  const fromEnvironment = await environmentCredential(ctx);
  if (fromEnvironment !== undefined) return fromEnvironment;
  const fromWorkloadIdentity = await workloadIdentityCredential(ctx);
  if (fromWorkloadIdentity !== undefined) return fromWorkloadIdentity;
  if (configured(ctx.environment, "AZURE_CLIENT_CERTIFICATE_PATH") !== undefined) {
    throw new Error("Azure certificate service-principal credentials are not supported by this resolver");
  }
  const fromAppService = await appServiceManagedIdentity(ctx);
  if (fromAppService !== undefined) return fromAppService;
  const fromImds = await imdsManagedIdentity(ctx);
  if (fromImds !== undefined) return fromImds;
  return azureCliCredential(ctx);
}
