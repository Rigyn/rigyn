import { createHash, createHmac } from "node:crypto";
import { resolveAwsRegion } from "../auth/aws-credentials.js";
import { isJsonValue, type JsonValue } from "../core/json.js";
import type {
  AdapterEvent,
  FinishReason,
  ImageBlock,
  ModelCapability,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponseDiagnostics,
  ProviderState,
} from "../core/types.js";
import { catalogId } from "./catalog.js";
import { requireBody } from "./lines.js";
import { normalizeImageSource, requireImageMediaType, unsupportedImageUrl } from "./images.js";
import { sanitizeUnicode, stringifyProviderJson } from "./json.js";
import { providerWireRequest } from "./messages.js";
import { toolResultText } from "./tool-results.js";
import { normalizeUsage } from "./usage.js";
import { parseJsonWithRepair } from "./streaming-json.js";
import type { ProviderWireOperation, ProviderWireTransportHost } from "./wire.js";
import { baseModelCompatibility, modelEvidence, providerModalities } from "./model-metadata.js";
import { openBedrockSdkStream } from "./bedrock-sdk-transport.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  assertResponseOk,
  assertSecureEndpoint,
  type FetchLike,
  jsonValueOrString,
  InvalidProviderRequestError,
  normalizeError,
  ProtocolError,
  ProviderStreamError,
  requestIdFromHeaders,
  responseDiagnostics,
  readJsonResponse,
  resolveToken,
  type TokenSource,
} from "./transport.js";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsSignerContext {
  region: string;
  service: string;
  target?: "control" | "runtime";
}

export interface BedrockSignerContext extends AwsSignerContext {
  service: "bedrock";
  target: "control" | "runtime";
}

export type BedrockSigner = (request: Request, context: BedrockSignerContext) => Request | Promise<Request>;
export type AwsCredentialSource = AwsCredentials | ((signal?: AbortSignal) => AwsCredentials | Promise<AwsCredentials>);

export interface BedrockConfig {
  region?: string;
  profile?: string;
  environment?: NodeJS.ProcessEnv;
  bearerToken?: TokenSource;
  credentials?: AwsCredentialSource;
  signer?: BedrockSigner;
  runtimeEndpoint?: string;
  controlEndpoint?: string;
  headers?: HeadersInit;
  fetch?: FetchLike;
  wire?: ProviderWireTransportHost;
  now?: () => Date;
  promptCache?: "off" | "5m" | "1h";
  /** Controls returned Claude reasoning text while preserving signed continuation state. */
  thinkingDisplay?: "summarized" | "omitted";
  /** Enables interleaved tool/reasoning turns for compatible non-adaptive Claude models. */
  interleavedThinking?: boolean;
}

export type AwsEventHeader = string | number | bigint | boolean | Uint8Array;

export interface AwsEventStreamMessage {
  headers: Record<string, AwsEventHeader>;
  payload: Uint8Array;
}

interface BedrockTool {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
  ended: boolean;
}

interface BedrockProtocolEvent {
  eventType?: string;
  messageType?: string;
  exceptionType?: string;
  payload: unknown;
  raw: JsonValue;
}

interface OpenedBedrockProtocolStream {
  events: AsyncIterable<BedrockProtocolEvent>;
  requestId?: string;
  diagnostics?: ProviderResponseDiagnostics;
}

export class BedrockAdapter implements ProviderAdapter {
  readonly id = "bedrock" as const;
  readonly #config: BedrockConfig;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #runtimeEndpoint: string | undefined;
  readonly #controlEndpoint: string | undefined;
  readonly #fetch: FetchLike;
  #profileRegion?: Promise<string | undefined>;

  constructor(config: BedrockConfig) {
    if (config.region !== undefined) assertBedrockRegion(config.region);
    if (
      config.profile !== undefined &&
      (config.profile.trim() === "" || Buffer.byteLength(config.profile, "utf8") > 256 || /[\x00-\x1f\x7f]/u.test(config.profile))
    ) {
      throw new TypeError("Bedrock profile is invalid");
    }
    if (config.promptCache !== undefined && !["off", "5m", "1h"].includes(config.promptCache)) {
      throw new TypeError("Bedrock promptCache must be off, 5m, or 1h");
    }
    this.#config = config;
    this.#environment = config.environment ?? process.env;
    this.#runtimeEndpoint = config.runtimeEndpoint === undefined ? undefined : trimSlash(config.runtimeEndpoint);
    this.#controlEndpoint = config.controlEndpoint === undefined ? undefined : trimSlash(config.controlEndpoint);
    if (this.#runtimeEndpoint !== undefined) assertSecureEndpoint(this.#runtimeEndpoint, "Bedrock runtime endpoint");
    if (this.#controlEndpoint !== undefined) assertSecureEndpoint(this.#controlEndpoint, "Bedrock control endpoint");
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    let partial = false;
    let terminal = false;
    let requestId: string | undefined;
    let diagnostics: ProviderResponseDiagnostics | undefined;

    try {
      const opened = await this.#openRuntimeStream(request, signal);
      requestId = opened.requestId;
      diagnostics = opened.diagnostics;

      let started = false;
      let stopReason: string | undefined;
      let sawMessageStop = false;
      const blocks = new Map<number, Record<string, unknown>>();
      const tools = new Map<number, BedrockTool>();

      for await (const message of opened.events) {
        const { messageType, eventType, exceptionType, payload } = message;
        const event = asRecord(payload) ?? {};

        if (messageType === "exception" || exceptionType !== undefined || eventType?.endsWith("Exception") === true) {
          throw new ProviderStreamError(
            asString(event.message) ?? asString(event.Message) ?? "Bedrock stream failed",
            exceptionType ?? eventType,
            jsonValueOrString(payload),
          );
        }
        if (eventType === undefined) {
          yield { type: "unknown_provider_event", provider: this.id, raw: message.raw };
          continue;
        }

        if (eventType === "messageStart") {
          if (!started) {
            started = true;
            const start: Extract<AdapterEvent, { type: "response_start" }> = {
              type: "response_start",
              model: request.model,
              ...(diagnostics === undefined ? {} : { diagnostics }),
              ...(requestId === undefined ? {} : { requestId }),
            };
            yield start;
          }
          continue;
        }

        if (!started) {
          started = true;
          const start: Extract<AdapterEvent, { type: "response_start" }> = {
            type: "response_start",
            model: request.model,
            ...(diagnostics === undefined ? {} : { diagnostics }),
            ...(requestId === undefined ? {} : { requestId }),
          };
          yield start;
        }

        if (eventType === "contentBlockStart") {
          const index = asNumber(event.contentBlockIndex) ?? 0;
          const start = asRecord(event.start);
          const toolUse = asRecord(start?.toolUse);
          if (toolUse !== undefined) {
            const tool: BedrockTool = { index, arguments: "", ended: false };
            const id = asString(toolUse.toolUseId);
            const name = asString(toolUse.name);
            if (id !== undefined) tool.id = id;
            if (name !== undefined) tool.name = name;
            tools.set(index, tool);
            blocks.set(index, { toolUse: { ...toolUse, input: {} } });
            partial = true;
            const toolStart: AdapterEvent = { type: "tool_call_start", index };
            if (id !== undefined) toolStart.id = id;
            if (name !== undefined) toolStart.name = name;
            yield toolStart;
          } else {
            blocks.set(index, start === undefined ? {} : { ...start });
          }
          continue;
        }

        if (eventType === "contentBlockDelta") {
          const index = asNumber(event.contentBlockIndex) ?? 0;
          const delta = asRecord(event.delta);
          if (delta === undefined) throw new ProtocolError("Bedrock content delta omitted delta", jsonValueOrString(payload));
          let block = blocks.get(index);
          if (block === undefined) {
            block = {};
            blocks.set(index, block);
          }

          const text = asString(delta.text);
          if (text !== undefined && text !== "") {
            block.text = (asString(block.text) ?? "") + text;
            partial = true;
            yield { type: "text_delta", part: index, text };
          }

          const toolDelta = asRecord(delta.toolUse);
          if (toolDelta !== undefined) {
            let tool = tools.get(index);
            if (tool === undefined) {
              tool = { index, arguments: "", ended: false };
              tools.set(index, tool);
              partial = true;
              yield { type: "tool_call_start", index };
            }
            const fragment = asString(toolDelta.input) ?? "";
            tool.arguments += fragment;
            yield { type: "tool_call_delta", index, jsonFragment: fragment };
          }

          const reasoning = asRecord(delta.reasoningContent);
          if (reasoning !== undefined) {
            updateReasoningBlock(block, reasoning);
            const reasoningText = asString(reasoning.text);
            if (reasoningText !== undefined && reasoningText !== "") {
              partial = true;
              yield {
                type: "reasoning_delta",
                part: index,
                text: reasoningText,
                visibility: "provider_trace",
              };
            }
          }

          if (text === undefined && toolDelta === undefined && reasoning === undefined) {
            yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(payload) };
          }
          continue;
        }

        if (eventType === "contentBlockStop") {
          const index = asNumber(event.contentBlockIndex) ?? 0;
          const tool = tools.get(index);
          if (tool !== undefined && !tool.ended) {
            const finished = finishTool(tool);
            const block = blocks.get(index);
            const toolBlock = asRecord(block?.toolUse);
            if (toolBlock !== undefined && finished.type === "tool_call_end" && finished.arguments !== undefined) {
              toolBlock.input = finished.arguments;
            }
            yield finished;
          }
          continue;
        }

        if (eventType === "messageStop") {
          stopReason = asString(event.stopReason) ?? stopReason;
          sawMessageStop = true;
          continue;
        }

        if (eventType === "metadata") {
          const usage = bedrockUsage(event.usage);
          if (usage !== undefined) yield { type: "usage", usage, semantics: "final" };
          if (!sawMessageStop) throw new ProtocolError("Bedrock metadata arrived before messageStop", jsonValueOrString(payload));
          for (const tool of tools.values()) {
            if (!tool.ended) {
              const finished = finishTool(tool);
              const toolBlock = asRecord(blocks.get(tool.index)?.toolUse);
              if (toolBlock !== undefined && finished.type === "tool_call_end" && finished.arguments !== undefined) {
                toolBlock.input = finished.arguments;
              }
              yield finished;
            }
          }
          terminal = true;
          const end: AdapterEvent = {
            type: "response_end",
            reason: mapBedrockFinish(stopReason, tools.size > 0),
            state: bedrockState(blocks),
          };
          if (stopReason !== undefined) end.rawReason = stopReason;
          yield end;
          return;
        }

        yield { type: "unknown_provider_event", provider: this.id, raw: jsonValueOrString(payload) };
      }

      if (!terminal) throw new ProtocolError("Bedrock event stream ended before metadata");
    } catch (error) {
      if (!terminal) {
        terminal = true;
        yield { type: "error", error: normalizeError(this.id, error, { partial, signal, requestId, diagnostics }) };
      }
    }
  }

  async #openRuntimeStream(request: ProviderRequest, signal: AbortSignal): Promise<OpenedBedrockProtocolStream> {
    const target = await this.#resolveTarget("runtime", request.model);
    const modelId = encodeURIComponent(request.model);
    const targetUrl = `${target.endpoint}/model/${modelId}/converse-stream`;
    const unsigned = new Request(targetUrl, {
      method: "POST",
      headers: requestHeaders(this.#config.headers, "application/vnd.amazon.eventstream"),
      body: stringifyProviderJson(buildConverseBody(request, { ...this.#config, region: target.region })),
      signal,
      redirect: "error",
    });
    if (this.#config.signer !== undefined) {
      const response = await this.#signedFetch(unsigned, "runtime", target.region, signal);
      await assertResponseOk(response);
      const legacyRequestId = requestIdFromHeaders(response.headers);
      return {
        events: bedrockWireProtocolEvents(requireBody(response)),
        ...(legacyRequestId === undefined ? {} : { requestId: legacyRequestId }),
        diagnostics: responseDiagnostics(response),
      };
    }

    const operation = this.#config.wire?.begin(this.id);
    const prepared = await prepareBedrockWireRequest(unsigned, operation, signal);
    const body = await readRequestJson(prepared);
    const bearerToken = await resolveToken(this.#config.bearerToken, signal);
    const credentials = bearerToken === undefined
      ? await resolveCredentials(this.#config.credentials, signal)
      : undefined;
    const opened = await openBedrockSdkStream({
      modelId: request.model,
      body,
      region: target.region,
      endpoint: target.endpoint,
      ...(prepared.url === targetUrl ? {} : { targetUrl: prepared.url }),
      headers: prepared.headers,
      ...(bearerToken === undefined ? {} : { bearerToken }),
      ...(credentials === undefined ? {} : { credentials }),
      signal,
      fetch: this.#fetch,
      onResponse: async (response) => {
        await operation?.observe({
          url: response.url || prepared.url,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers),
        }, signal);
      },
    });
    return {
      events: bedrockSdkProtocolEvents(opened.stream),
      ...(opened.requestId === undefined ? {} : { requestId: opened.requestId }),
      ...(opened.diagnostics === undefined ? {} : { diagnostics: opened.diagnostics }),
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const target = await this.#resolveTarget("control");
    const url = new URL(`${target.endpoint}/foundation-models`);
    url.searchParams.set("byOutputModality", "TEXT");
    const request = new Request(url, {
      headers: requestHeaders(this.#config.headers, "application/json"),
      signal,
      redirect: "error",
    });
    const response = await this.#signedFetch(request, "control", target.region, signal);
    await assertResponseOk(response);
    const body = await readJsonResponse(response);
    const observedAt = new Date().toISOString();
    return asArray(asRecord(body)?.modelSummaries).flatMap((entry): ModelInfo[] => {
      const model = asRecord(entry);
      const id = catalogId(model?.modelId);
      if (id === undefined) return [];
      const inputModalities = asArray(model?.inputModalities)
        .filter((value): value is string => typeof value === "string");
      const outputModalities = asArray(model?.outputModalities)
        .filter((value): value is string => typeof value === "string");
      if (outputModalities.length > 0 && !outputModalities.includes("TEXT")) return [];
      const capabilities = {
        tools: unknownCapability(observedAt),
        reasoning: unknownCapability(observedAt),
        images: capability(inputModalities.includes("IMAGE"), inputModalities.length > 0, observedAt),
      };
      const compatibility = baseModelCompatibility("bedrock-converse", capabilities.tools, observedAt);
      const providerInputModalities = providerModalities(model?.inputModalities, observedAt);
      const providerOutputModalities = providerModalities(model?.outputModalities, observedAt);
      if (providerInputModalities !== undefined) compatibility.inputModalities = providerInputModalities;
      if (providerOutputModalities !== undefined) compatibility.outputModalities = providerOutputModalities;
      const promptCache = (this.#config.promptCache ?? "5m") !== "off" &&
          bedrockPromptCachingSupported(id, asString(model?.modelName))
        ? this.#config.promptCache ?? "5m"
        : "off";
      compatibility.cacheMode = modelEvidence(promptCache === "off" ? "none" : "explicit", "configuration", observedAt);
      compatibility.cacheAffinity = modelEvidence(promptCache === "off" ? "none" : "prefix", "configuration", observedAt);
      if (promptCache !== "off") compatibility.cacheTiers = modelEvidence([promptCache], "configuration", observedAt);
      const info: ModelInfo = {
        id,
        provider: this.id,
        capabilities,
        compatibility,
        metadata: jsonValueOrString(model),
      };
      const displayName = asString(model?.modelName);
      if (displayName !== undefined) info.displayName = displayName;
      return [info];
    });
  }

  async #signedFetch(
    request: Request,
    target: BedrockSignerContext["target"],
    region: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const context: BedrockSignerContext = { region, service: "bedrock", target };
    const operation = this.#config.wire?.begin(this.id);
    let signed: Request;
    if (this.#config.signer !== undefined) {
      signed = await this.#config.signer(await prepareBedrockWireRequest(request, operation, signal), context);
    } else {
      const bearerToken = await resolveToken(this.#config.bearerToken, signal);
      if (bearerToken !== undefined) {
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${bearerToken}`);
        signed = await prepareBedrockWireRequest(new Request(request, { headers }), operation, signal);
      } else {
        const credentials = await resolveCredentials(this.#config.credentials, signal);
        if (credentials === undefined) {
          throw new ProviderStreamError(
            "AWS credentials are unavailable; configure a Bedrock API key, credentials, or a signer",
            "authentication",
          );
        }
        const prepared = await prepareBedrockWireRequest(request, operation, signal);
        signed = await signAwsRequest(prepared, credentials, context, this.#config.now?.() ?? new Date());
      }
    }
    const response = await this.#fetch(new Request(signed, { redirect: "error" }));
    await operation?.observe({
      url: response.url || signed.url,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    }, signal);
    return response;
  }

  async #resolveTarget(target: BedrockSignerContext["target"], model?: string): Promise<{ endpoint: string; region: string }> {
    const configuredEndpoint = target === "runtime" ? this.#runtimeEndpoint : this.#controlEndpoint;
    const arnRegion = model === undefined ? undefined : bedrockArnRegion(model);
    const environmentRegion = configuredAwsRegion(this.#environment);
    const endpointRegion = configuredEndpoint === undefined ? undefined : standardBedrockEndpointRegion(configuredEndpoint);
    let region = arnRegion
      ?? this.#config.region
      ?? environmentRegion
      ?? endpointRegion;
    if (region === undefined) {
      this.#profileRegion ??= resolveAwsRegion({
        environment: this.#environment,
        ...(this.#config.profile === undefined ? {} : { profile: this.#config.profile }),
      });
      region = await this.#profileRegion ?? "us-east-1";
    }
    assertBedrockRegion(region);
    return {
      region,
      endpoint: configuredEndpoint ?? defaultBedrockEndpoint(target, region),
    };
  }
}

function assertBedrockRegion(region: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(region) || region.length > 64) {
    throw new TypeError("Bedrock region is invalid");
  }
}

function configuredAwsRegion(environment: NodeJS.ProcessEnv): string | undefined {
  const region = environment.AWS_REGION?.trim() || environment.AWS_DEFAULT_REGION?.trim();
  if (region !== undefined && region !== "") assertBedrockRegion(region);
  return region === "" ? undefined : region;
}

function bedrockArnRegion(model: string): string | undefined {
  const region = /^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/iu.exec(model)?.[1]?.toLowerCase();
  if (region !== undefined) assertBedrockRegion(region);
  return region;
}

function standardBedrockEndpointRegion(endpoint: string): string | undefined {
  const hostname = new URL(endpoint).hostname.toLowerCase();
  const region = /^bedrock(?:-runtime)?(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/u.exec(hostname)?.[1];
  if (region !== undefined) assertBedrockRegion(region);
  return region;
}

function defaultBedrockEndpoint(target: BedrockSignerContext["target"], region: string): string {
  const hostname = target === "runtime" ? "bedrock-runtime" : "bedrock";
  const suffix = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://${hostname}.${region}.${suffix}`;
}

async function prepareBedrockWireRequest(
  request: Request,
  operation: ProviderWireOperation | undefined,
  signal: AbortSignal,
): Promise<Request> {
  if (operation?.active !== true) return request;
  let body: JsonValue | undefined;
  if (request.body !== null) {
    const text = await request.clone().text();
    if (text !== "") {
      const parsed: unknown = JSON.parse(text);
      if (!isJsonValue(parsed)) throw new TypeError("Bedrock request body must be JSON");
      body = parsed;
    }
  }
  const prepared = await operation.intercept({
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(body === undefined ? {} : { body }),
  }, signal);
  if (!prepared.bodyChanged && !prepared.headersChanged && !prepared.urlChanged) return request;
  if (prepared.bodyChanged) prepared.headers.delete("content-length");
  return new Request(prepared.url, {
    method: request.method,
    headers: prepared.headers,
    signal: request.signal,
    redirect: request.redirect,
    ...(prepared.bodyChanged ? { body: stringifyProviderJson(prepared.body!) } : {}),
    ...(!prepared.bodyChanged && request.body !== null ? { body: request.body, duplex: "half" } : {}),
  });
}

async function readRequestJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.clone().text();
  const parsed: unknown = JSON.parse(text);
  const body = asRecord(parsed);
  if (body === undefined) throw new TypeError("Bedrock request body must be a JSON object");
  return body;
}

async function* bedrockWireProtocolEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<BedrockProtocolEvent> {
  for await (const message of decodeAwsEventStream(stream)) {
    const payload = parsePayload(message.payload);
    const eventType = headerString(message.headers[":event-type"]);
    const messageType = headerString(message.headers[":message-type"]);
    const exceptionType = headerString(message.headers[":exception-type"]);
    yield {
      ...(eventType === undefined ? {} : { eventType }),
      ...(messageType === undefined ? {} : { messageType }),
      ...(exceptionType === undefined ? {} : { exceptionType }),
      payload,
      raw: eventStreamRaw(message, payload),
    };
  }
}

async function* bedrockSdkProtocolEvents(stream: AsyncIterable<unknown>): AsyncIterable<BedrockProtocolEvent> {
  for await (const item of stream) {
    const event = asRecord(item);
    if (event === undefined) {
      yield { payload: {}, raw: jsonValueOrString(item) };
      continue;
    }
    const eventType = BEDROCK_SDK_EVENT_KEYS.find((key) => event[key] !== undefined);
    if (eventType === undefined) {
      yield { payload: {}, raw: jsonValueOrString(item) };
      continue;
    }
    const payload = event[eventType];
    yield {
      eventType,
      ...(eventType.endsWith("Exception") ? { messageType: "exception", exceptionType: eventType } : {}),
      payload,
      raw: jsonValueOrString(item),
    };
  }
}

const BEDROCK_SDK_EVENT_KEYS = [
  "messageStart",
  "contentBlockStart",
  "contentBlockDelta",
  "contentBlockStop",
  "messageStop",
  "metadata",
  "internalServerException",
  "modelStreamErrorException",
  "validationException",
  "throttlingException",
  "serviceUnavailableException",
] as const;

export async function signAwsRequest(
  request: Request,
  credentials: AwsCredentials,
  context: AwsSignerContext,
  now: Date = new Date(),
): Promise<Request> {
  const url = new URL(request.url);
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const payloadHash = sha256(body);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers = new Headers(request.headers);
  headers.set("x-amz-date", amzDate);
  headers.set("x-amz-content-sha256", payloadHash);
  if (credentials.sessionToken !== undefined) headers.set("x-amz-security-token", credentials.sessionToken);

  const canonical = canonicalHeaders(headers, url.host);
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url),
    canonical.text,
    canonical.names,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${context.region}/${context.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, date);
  const regionKey = hmac(dateKey, context.region);
  const serviceKey = hmac(regionKey, context.service);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${canonical.names}, Signature=${signature}`,
  );

  const init: RequestInit = { method: request.method, headers, signal: request.signal, redirect: "error" };
  if (body.length > 0 && request.method !== "GET" && request.method !== "HEAD") init.body = body;
  return new Request(request.url, init);
}

export async function* decodeAwsEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<AwsEventStreamMessage, void, undefined> {
  const reader = stream.getReader();
  let buffer = new Uint8Array();
  let finished = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        finished = true;
        break;
      }
      buffer = concatBytes(buffer, result.value);
      while (buffer.length >= 12) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const totalLength = view.getUint32(0);
        const headersLength = view.getUint32(4);
        if (totalLength < 16 || totalLength > 64 * 1024 * 1024 || headersLength > totalLength - 16) {
          throw new ProtocolError("Invalid AWS event-stream frame lengths");
        }
        if (buffer.length < totalLength) break;
        const frame = buffer.slice(0, totalLength);
        buffer = buffer.slice(totalLength);
        const frameView = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        if (crc32(frame.subarray(0, 8)) !== frameView.getUint32(8)) {
          throw new ProtocolError("AWS event-stream prelude CRC mismatch");
        }
        if (crc32(frame.subarray(0, totalLength - 4)) !== frameView.getUint32(totalLength - 4)) {
          throw new ProtocolError("AWS event-stream message CRC mismatch");
        }
        const headerBytes = frame.subarray(12, 12 + headersLength);
        const payload = frame.slice(12 + headersLength, totalLength - 4);
        yield { headers: decodeAwsHeaders(headerBytes), payload };
      }
    }
    if (buffer.length !== 0) throw new ProtocolError("Truncated AWS event-stream frame");
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

type BedrockRequestConfig = Omit<
  Pick<BedrockConfig, "region" | "environment" | "promptCache" | "thinkingDisplay" | "interleavedThinking">,
  "region"
> & { region: string };

function buildConverseBody(
  request: ProviderRequest,
  config: BedrockRequestConfig,
): Record<string, unknown> {
  request = providerWireRequest(request, request.providerState?.kind === "bedrock_converse");
  const supportsPromptCaching = request.modelSettings?.compatibility?.supportsPromptCaching ?? (
    config.environment?.AWS_BEDROCK_FORCE_CACHE === "1" || bedrockPromptCachingSupported(request.model)
  );
  const configuredCache = request.cacheRetention === undefined
    ? config.promptCache ?? "5m"
    : request.cacheRetention === "none" ? "off" : request.cacheRetention === "long" ? "1h" : "5m";
  const promptCache = !supportsPromptCaching || configuredCache === "off"
    ? "off"
    : configuredCache === "1h" && request.modelSettings?.compatibility?.supportsLongCacheRetention === false
      ? "5m"
      : configuredCache;
  const cachePoint = promptCache === "off"
    ? undefined
    : { cachePoint: { type: "default", ...(promptCache === "1h" ? { ttl: "1h" } : {}) } };
  const messages = buildBedrockMessages(request);
  const body: Record<string, unknown> = {
    messages: cachePoint === undefined ? messages : appendMessageCachePoint(messages, cachePoint),
  };
  const system = request.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => sanitizeUnicode(block.text))
    .filter((text) => text.trim() !== "")
    .map((text) => ({ text }));
  if (system.length > 0) body.system = cachePoint === undefined ? system : [...system, cachePoint];
  if (request.temperature !== undefined &&
      (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 1)) {
    throw new InvalidProviderRequestError("Bedrock temperature must be between 0 and 1");
  }
  if (request.maxOutputTokens !== undefined || request.temperature !== undefined) {
    body.inferenceConfig = {
      ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    };
  }
  const reasoning = bedrockReasoningFields(request, config);
  if (reasoning !== undefined) body.additionalModelRequestFields = reasoning;
  if (request.tools.length > 0 && request.toolChoice !== "none") {
    const tools: unknown[] = request.tools.map((tool) => ({
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: { json: tool.inputSchema },
      },
    }));
    if (cachePoint !== undefined) tools.push(cachePoint);
    body.toolConfig = {
      tools,
      ...(request.toolChoice === undefined
        ? {}
        : request.toolChoice === "auto"
          ? { toolChoice: { auto: {} } }
          : request.toolChoice === "required"
            ? { toolChoice: { any: {} } }
            : { toolChoice: { tool: { name: request.toolChoice.function.name } } }),
    };
  }
  if (request.metadata !== undefined) body.requestMetadata = request.metadata;
  return body;
}

function appendMessageCachePoint(messages: unknown[], cachePoint: Record<string, unknown>): unknown[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    const content = asArray(message?.content);
    if (message === undefined || content.length === 0) continue;
    return messages.map((entry, entryIndex) => entryIndex === index
      ? { ...message, content: [...content, cachePoint] }
      : entry);
  }
  return messages;
}

function buildBedrockMessages(request: ProviderRequest): unknown[] {
  const state = request.providerState?.kind === "bedrock_converse" ? request.providerState : undefined;
  const lastAssistant = findLastAssistant(request);
  const result: unknown[] = [];
  for (let index = 0; index < request.messages.length; index += 1) {
    const message = request.messages[index]!;
    if (message.role === "system") continue;
    if (state !== undefined && index === lastAssistant) {
      result.push(state.assistantMessage);
      continue;
    }
    if (message.role === "tool") {
      const content: unknown[] = [];
      let cursor = index;
      while (cursor < request.messages.length && request.messages[cursor]?.role === "tool") {
        content.push(...bedrockMessageContent(request.messages[cursor]!, true));
        cursor += 1;
      }
      result.push({ role: "user", content: content.length === 0 ? [{ text: "<empty>" }] : content });
      index = cursor - 1;
      continue;
    }
    const content = bedrockMessageContent(message, false);
    if (message.role === "assistant" && content.length === 0) continue;
    result.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: content.length === 0 ? [{ text: "<empty>" }] : content,
    });
  }
  return result;
}

function bedrockMessageContent(message: ProviderRequest["messages"][number], toolResultOnly: boolean): unknown[] {
  return message.content.flatMap((block): unknown[] => {
    if (block.type === "text" && !toolResultOnly) {
      const text = sanitizeUnicode(block.text);
      return text.trim() === "" ? [] : [{ text }];
    }
    if (block.type === "image" && !toolResultOnly) return [bedrockImageContent(block)];
    if (block.type === "tool_call" && !toolResultOnly) {
      return [{ toolUse: { toolUseId: block.callId, name: block.name, input: block.arguments } }];
    }
    if (block.type === "tool_result") {
      const text = sanitizeUnicode(block.content === "" ? "" : toolResultText(block));
      const content: unknown[] = [
        ...(text.trim() === "" ? [] : [{ text }]),
        ...(block.images ?? []).map(bedrockImageContent),
      ];
      return [{
        toolResult: {
          toolUseId: block.callId,
          content: content.length === 0 ? [{ text: "<empty>" }] : content,
          status: block.isError ? "error" : "success",
        },
      }];
    }
    if (block.type === "provider_opaque" && block.provider === "bedrock" && !toolResultOnly) return [block.value];
    return [];
  });
}

function bedrockReasoningFields(
  request: ProviderRequest,
  config: Pick<BedrockRequestConfig, "region" | "thinkingDisplay" | "interleavedThinking">,
): Record<string, unknown> | undefined {
  const requested = request.reasoningEffort;
  if (requested === undefined || requested === "off" || !isAnthropicBedrockModel(request.model)) return undefined;
  const display = isGovCloudBedrockTarget(request.model, config.region)
    ? undefined
    : config.thinkingDisplay ?? "summarized";
  if (supportsAdaptiveBedrockThinking(request.model)) {
    return {
      thinking: { type: "adaptive", ...(display === undefined ? {} : { display }) },
      output_config: { effort: bedrockThinkingEffort(requested) },
    };
  }
  const level = requested === "minimal" || requested === "low" || requested === "medium" || requested === "high"
    ? requested
    : "high";
  const defaults: Record<typeof level, number> = {
    minimal: 1_024,
    low: 2_048,
    medium: 8_192,
    high: 16_384,
  };
  const requestedBudget = request.thinkingBudgets?.[level] ?? defaults[level];
  const budget = request.maxOutputTokens === undefined
    ? requestedBudget
    : Math.min(requestedBudget, Math.max(0, request.maxOutputTokens - 1_024));
  const fields: Record<string, unknown> = {
    thinking: {
      type: "enabled",
      budget_tokens: budget,
      ...(display === undefined ? {} : { display }),
    },
  };
  if (config.interleavedThinking ?? true) fields.anthropic_beta = ["interleaved-thinking-2025-05-14"];
  return fields;
}

function bedrockModelCandidates(model: string): string[] {
  const lower = model.toLowerCase();
  return [lower, lower.replace(/[\s_.:]+/gu, "-")];
}

function bedrockPromptCachingSupported(model: string, displayName?: string): boolean {
  const candidates = [
    ...bedrockModelCandidates(model),
    ...(displayName === undefined ? [] : bedrockModelCandidates(displayName)),
  ];
  if (!candidates.some((candidate) => candidate.includes("claude"))) return false;
  return candidates.some((candidate) =>
    candidate.includes("fable-5") ||
    candidate.includes("sonnet-5") ||
    candidate.includes("-4-") ||
    candidate.includes("claude-3-7-sonnet") ||
    candidate.includes("claude-3-5-haiku"));
}

function isAnthropicBedrockModel(model: string): boolean {
  return bedrockModelCandidates(model).some((candidate) => candidate.includes("anthropic") || candidate.includes("claude"));
}

function supportsAdaptiveBedrockThinking(model: string): boolean {
  return bedrockModelCandidates(model).some((candidate) =>
    ["opus-4-6", "opus-4-7", "opus-4-8", "sonnet-4-6", "sonnet-5", "fable-5"]
      .some((fragment) => candidate.includes(fragment)));
}

function bedrockThinkingEffort(value: string): "low" | "medium" | "high" | "xhigh" | "max" {
  if (value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  return "low";
}

function isGovCloudBedrockTarget(model: string, region: string): boolean {
  const lower = model.toLowerCase();
  return region.toLowerCase().startsWith("us-gov-") || lower.startsWith("us-gov.") || lower.startsWith("arn:aws-us-gov:");
}

function bedrockImageContent(block: ImageBlock): unknown {
  const source = normalizeImageSource(block, "Bedrock Converse");
  requireImageMediaType(source, "Bedrock Converse", ["image/jpeg", "image/png", "image/gif", "image/webp"]);
  return {
    image: {
      format: imageFormat(source.mediaType),
      source: source.kind === "base64"
        ? { bytes: source.data }
        : bedrockImageUrl(source.url),
    },
  };
}

function findLastAssistant(request: ProviderRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === "assistant") return index;
  }
  return -1;
}

function finishTool(tool: BedrockTool): AdapterEvent {
  tool.ended = true;
  const event: AdapterEvent = {
    type: "tool_call_end",
    index: tool.index,
    name: tool.name ?? "unknown_tool",
    rawArguments: tool.arguments,
  };
  if (tool.id !== undefined) event.id = tool.id;
  try {
    event.arguments = jsonValueOrString(parseJsonWithRepair(tool.arguments === "" ? "{}" : tool.arguments));
  } catch (error) {
    event.parseError = error instanceof Error ? error.message : String(error);
  }
  return event;
}

function updateReasoningBlock(block: Record<string, unknown>, delta: Record<string, unknown>): void {
  let reasoning = asRecord(block.reasoningContent);
  if (reasoning === undefined) {
    reasoning = {};
    block.reasoningContent = reasoning;
  }
  let reasoningText = asRecord(reasoning.reasoningText);
  if (reasoningText === undefined) {
    reasoningText = {};
    reasoning.reasoningText = reasoningText;
  }
  const text = asString(delta.text);
  if (text !== undefined) reasoningText.text = (asString(reasoningText.text) ?? "") + text;
  const signature = asString(delta.signature);
  if (signature !== undefined) reasoningText.signature = signature;
  if (delta.redactedContent !== undefined) reasoning.redactedContent = delta.redactedContent;
}

function bedrockState(blocks: Map<number, Record<string, unknown>>): ProviderState {
  return {
    kind: "bedrock_converse",
    assistantMessage: {
      role: "assistant",
      content: [...blocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, block]) => jsonValueOrString(block)),
    },
  };
}

function bedrockUsage(value: unknown): NormalizedUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  return normalizeUsage({
    raw: jsonValueOrString(usage),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reportedTotalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadInputTokens,
    cacheWriteTokens: usage.cacheWriteInputTokens,
  });
}

function mapBedrockFinish(reason: string | undefined, sawTools: boolean): FinishReason {
  if (reason === "tool_use" || (reason === undefined && sawTools)) return "tool_calls";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "model_context_window_exceeded") return "context_limit";
  if (reason === "guardrail_intervened" || reason === "content_filtered") return "content_filter";
  if (reason === "malformed_model_output" || reason === "malformed_tool_use") return "error";
  return "unknown";
}

function requestHeaders(initial: HeadersInit | undefined, accept: string): Headers {
  const headers = new Headers(initial);
  headers.set("content-type", "application/json");
  headers.set("accept", accept);
  return headers;
}

async function resolveCredentials(source: AwsCredentialSource | undefined, signal: AbortSignal): Promise<AwsCredentials | undefined> {
  if (source !== undefined) return typeof source === "function" ? await source(signal) : source;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId === undefined || secretAccessKey === undefined) return undefined;
  const credentials: AwsCredentials = { accessKeyId, secretAccessKey };
  if (process.env.AWS_SESSION_TOKEN !== undefined) credentials.sessionToken = process.env.AWS_SESSION_TOKEN;
  return credentials;
}

function canonicalHeaders(headers: Headers, host: string): { text: string; names: string } {
  const values = new Map<string, string>();
  values.set("host", host.trim());
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase();
    if (["authorization", "content-length", "user-agent"].includes(name)) continue;
    values.set(name, rawValue.trim().replace(/\s+/g, " "));
  }
  const entries = [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
  return {
    text: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    names: entries.map(([name]) => name).join(";"),
  };
}

function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => awsEncode(safeDecode(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function decodeAwsHeaders(bytes: Uint8Array): Record<string, AwsEventHeader> {
  const headers: Record<string, AwsEventHeader> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  while (offset < bytes.length) {
    const nameLength = bytes[offset];
    if (nameLength === undefined || offset + 1 + nameLength >= bytes.length) {
      throw new ProtocolError("Malformed AWS event-stream header name");
    }
    offset += 1;
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = bytes[offset];
    if (type === undefined) throw new ProtocolError("Malformed AWS event-stream header type");
    offset += 1;
    if (type === 0) headers[name] = true;
    else if (type === 1) headers[name] = false;
    else if (type === 2) {
      requireHeaderBytes(bytes, offset, 1);
      headers[name] = view.getInt8(offset);
      offset += 1;
    } else if (type === 3) {
      requireHeaderBytes(bytes, offset, 2);
      headers[name] = view.getInt16(offset);
      offset += 2;
    } else if (type === 4) {
      requireHeaderBytes(bytes, offset, 4);
      headers[name] = view.getInt32(offset);
      offset += 4;
    } else if (type === 5 || type === 8) {
      requireHeaderBytes(bytes, offset, 8);
      headers[name] = view.getBigInt64(offset);
      offset += 8;
    } else if (type === 6 || type === 7) {
      requireHeaderBytes(bytes, offset, 2);
      const length = view.getUint16(offset);
      offset += 2;
      requireHeaderBytes(bytes, offset, length);
      const value = bytes.subarray(offset, offset + length);
      headers[name] = type === 7 ? decoder.decode(value) : value.slice();
      offset += length;
    } else if (type === 9) {
      requireHeaderBytes(bytes, offset, 16);
      headers[name] = uuid(bytes.subarray(offset, offset + 16));
      offset += 16;
    } else {
      throw new ProtocolError(`Unsupported AWS event-stream header type ${type}`);
    }
  }
  return headers;
}

function requireHeaderBytes(bytes: Uint8Array, offset: number, length: number): void {
  if (offset + length > bytes.length) throw new ProtocolError("Truncated AWS event-stream header");
}

function uuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CRC_TABLE = buildCrcTable();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ value) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function parsePayload(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return {};
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolError("AWS event-stream payload contained invalid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Malformed AWS event-stream JSON payload", text);
  }
}

function headerString(value: AwsEventHeader | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function eventStreamRaw(message: AwsEventStreamMessage, payload: unknown): JsonValue {
  const headers: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    headers[name] = value instanceof Uint8Array ? Buffer.from(value).toString("base64") : String(value);
  }
  return { headers, payload: jsonValueOrString(payload) };
}

function imageFormat(mediaType: string): string {
  return mediaType === "image/jpeg" ? "jpeg" : mediaType.slice("image/".length);
}

function bedrockImageUrl(url: string): { s3Location: { uri: string } } {
  if (url.length > 1024 || !/^s3:\/\/[a-z0-9][.a-z0-9-]{1,61}[a-z0-9](?:\/.*)?$/u.test(url)) {
    return unsupportedImageUrl("Bedrock Converse", url);
  }
  return { s3Location: { uri: url } };
}

function capability(supported: boolean, known: boolean, observedAt: string): ModelCapability {
  return { value: known ? (supported ? "supported" : "unsupported") : "unknown", source: "provider", observedAt };
}

function unknownCapability(observedAt: string): ModelCapability {
  return { value: "unknown", source: "provider", observedAt };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
