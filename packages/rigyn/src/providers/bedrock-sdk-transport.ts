import type {
  BedrockRuntimeClientConfig,
  ConverseStreamCommandInput,
  ConverseStreamCommandOutput,
  ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";

import type { ProviderResponseDiagnostics } from "../core/types.js";
import {
  type FetchLike,
  requestIdFromHeaders,
  responseDiagnostics,
} from "./transport.js";

type BedrockSdk = typeof import("@aws-sdk/client-bedrock-runtime");

export interface BedrockSdkCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface BedrockSdkStreamInput {
  modelId: string;
  body: Record<string, unknown>;
  region: string;
  endpoint: string;
  targetUrl?: string;
  headers: Headers;
  bearerToken?: string;
  credentials?: BedrockSdkCredentials;
  signal: AbortSignal;
  fetch: FetchLike;
  onResponse(response: Response): void | Promise<void>;
  loadSdk?: () => Promise<BedrockSdk>;
}

export interface OpenedBedrockSdkStream {
  stream: AsyncIterable<ConverseStreamOutput>;
  diagnostics?: ProviderResponseDiagnostics;
  requestId?: string;
}

/** Open an AWS Converse stream through the official client and a host-owned fetch boundary. */
export async function openBedrockSdkStream(input: BedrockSdkStreamInput): Promise<OpenedBedrockSdkStream> {
  const sdk = await (input.loadSdk?.() ?? import("@aws-sdk/client-bedrock-runtime"));
  let diagnostics: ProviderResponseDiagnostics | undefined;
  let observedRequestId: string | undefined;
  const requestHandler = new HostFetchHandler(input.fetch, async (response) => {
    diagnostics = responseDiagnostics(response);
    observedRequestId = requestIdFromHeaders(response.headers);
    await input.onResponse(response);
  });
  const config: BedrockRuntimeClientConfig = {
    region: input.region,
    endpoint: input.endpoint,
    requestHandler: requestHandler as unknown as NonNullable<BedrockRuntimeClientConfig["requestHandler"]>,
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    ...(input.bearerToken === undefined
      ? {}
      : {
          token: { token: input.bearerToken },
          authSchemePreference: ["httpBearerAuth"],
        }),
  };
  const client = new sdk.BedrockRuntimeClient(config);
  addRequestMiddleware(client, input.headers, input.targetUrl);
  const command = new sdk.ConverseStreamCommand(toCommandInput(input.modelId, input.body));
  let output: ConverseStreamCommandOutput;
  try {
    output = await client.send(command, { abortSignal: input.signal });
  } catch (error) {
    client.destroy();
    throw error;
  }
  if (output.stream === undefined) {
    client.destroy();
    throw new TypeError("Bedrock response omitted its event stream");
  }
  const opened: OpenedBedrockSdkStream = {
    stream: ownedStream(output.stream, () => client.destroy()),
  };
  if (diagnostics !== undefined) opened.diagnostics = diagnostics;
  const requestId = output.$metadata.requestId ?? observedRequestId;
  if (requestId !== undefined) opened.requestId = requestId;
  return opened;
}

async function* ownedStream<T>(stream: AsyncIterable<T>, dispose: () => void): AsyncIterable<T> {
  try {
    yield* stream;
  } finally {
    dispose();
  }
}

function toCommandInput(modelId: string, body: Record<string, unknown>): ConverseStreamCommandInput {
  const converted = convertBinaryFields(body) as Record<string, unknown>;
  return { ...converted, modelId } as unknown as ConverseStreamCommandInput;
}

function convertBinaryFields(value: unknown, key?: string): unknown {
  if (key === "bytes" && typeof value === "string") return Buffer.from(value, "base64");
  if (Array.isArray(value)) return value.map((entry) => convertBinaryFields(entry));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [entryKey, convertBinaryFields(entry, entryKey)]),
  );
}

function addRequestMiddleware(
  client: InstanceType<BedrockSdk["BedrockRuntimeClient"]>,
  headers: Headers,
  targetUrl: string | undefined,
): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as {
        protocol?: string;
        hostname?: string;
        port?: number;
        path?: string;
        query?: Record<string, string | string[] | null>;
        headers?: Record<string, string>;
      };
      if (request.headers !== undefined) {
        for (const [name, value] of headers) {
          if (!isReservedHeader(name)) request.headers[name] = value;
        }
      }
      if (targetUrl !== undefined) rewriteSmithyTarget(request, new URL(targetUrl));
      return next(args);
    },
    { step: "build", name: "rigynBedrockRequest", priority: "low" },
  );
}

function isReservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "host" || lower.startsWith("x-amz-");
}

function rewriteSmithyTarget(
  request: {
    protocol?: string;
    hostname?: string;
    port?: number;
    path?: string;
    query?: Record<string, string | string[] | null>;
  },
  target: URL,
): void {
  request.protocol = target.protocol;
  request.hostname = target.hostname;
  if (target.port === "") delete request.port;
  else request.port = Number(target.port);
  request.path = target.pathname;
  request.query = {};
  for (const [name, value] of target.searchParams) {
    const previous = request.query[name];
    request.query[name] = previous === undefined
      ? value
      : Array.isArray(previous)
        ? [...previous, value]
        : [previous ?? "", value];
  }
}

interface SmithyHttpRequest {
  protocol: string;
  hostname: string;
  port?: number;
  path: string;
  query?: Record<string, string | string[] | null>;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface SmithyHandlerOptions {
  abortSignal?: AbortSignal;
  requestTimeout?: number;
}

class HostFetchHandler {
  readonly metadata = { handlerProtocol: "http/1.1" };

  constructor(
    private readonly fetch: FetchLike,
    private readonly observe: (response: Response) => void | Promise<void>,
  ) {}

  async handle(
    request: SmithyHttpRequest,
    options: SmithyHandlerOptions = {},
  ): Promise<{ response: { statusCode: number; reason: string; headers: Record<string, string>; body: unknown } }> {
    const signal = timeoutSignal(options.abortSignal, options.requestTimeout);
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: request.headers,
      redirect: "error",
    };
    if (signal !== undefined) init.signal = signal;
    if (request.body !== undefined && request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body as BodyInit;
      init.duplex = "half";
    }
    const response = await this.fetch(new Request(smithyUrl(request), init));
    await this.observe(response);
    return {
      response: {
        statusCode: response.status,
        reason: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: response.body ?? new Uint8Array(await response.arrayBuffer()),
      },
    };
  }

  destroy(): void {}

  updateHttpClientConfig(): void {}

  httpHandlerConfigs(): Record<string, never> {
    return {};
  }
}

function smithyUrl(request: SmithyHttpRequest): string {
  const url = new URL(`${request.protocol}//${request.hostname}${request.port === undefined ? "" : `:${request.port}`}${request.path}`);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(name, item);
    } else if (value !== null) {
      url.searchParams.append(name, value);
    }
  }
  return url.toString();
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined || timeoutMs <= 0) return signal;
  return signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}
