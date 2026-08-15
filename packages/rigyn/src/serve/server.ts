import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { EventEnvelope } from "../core/events.js";
import type {
  AgentSessionEnvelopeListener,
  AgentSessionPromptOptions,
  AgentSessionRecoveryOptions,
  AgentSessionRecoveryResult,
  AgentSessionSuspendedRun,
  AgentSessionToolEffectResolution,
} from "../service/agent-session.js";
import { assertValidSessionId } from "../storage/session-manager.js";
import { MAX_TOOL_RESULT_CONTENT_BYTES } from "../tools/coordinator.js";
import { limitText } from "../tools/output.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_CLIENTS_PER_SESSION = 8;
const DEFAULT_MAX_PROMPT_ADMISSION_BYTES_PER_SESSION = 1024 * 1024;
const DEFAULT_MAX_PROMPT_ADMISSIONS_PER_SESSION = 32;
const DEFAULT_MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REPLAY_EVENTS = 256;
const DEFAULT_MAX_SESSIONS = 32;
const MAX_SSE_QUEUE_BYTES = 1024 * 1024;
const MAX_SSE_QUEUE_EVENTS = 256;
const SSE_DRAIN_TIMEOUT_MS = 5_000;
const MAX_SERVE_TOKEN_BYTES = 4_096;
const MIN_SERVE_TOKEN_BYTES = 32;
const MAX_RECOVERY_EFFECTS = 256;
const MAX_RECOVERY_EFFECT_ID_BYTES = 1_024;
const MAX_RECOVERY_QUEUE_IDS = 100;
const MAX_RECOVERY_RESOLUTIONS = 256;
const MAX_RECOVERY_REASON_BYTES = 4_096;
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+={0,}$/u;

export interface ServeCreateSessionRequest {
  workspace?: string;
}

export interface ServeOpenSessionRequest {
  sessionId: string;
  workspace?: string;
}

export interface ServeSessionSummary {
  model?: {
    provider: string;
    api: string;
    id: string;
  };
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  pendingMessageCount: number;
  messageCount: number;
  toolCount: number;
  hasSuspendedRun: boolean;
}

/**
 * The only execution surface used by the HTTP transport. Production wiring
 * adapts the canonical session runtime to this interface.
 */
export interface ServeSessionRuntime {
  readonly sessionId: string;
  readonly summary: ServeSessionSummary;
  readonly suspendedRun: AgentSessionSuspendedRun | undefined;
  onEvent(listener: AgentSessionEnvelopeListener): () => void;
  start?(signal: AbortSignal): Promise<void>;
  prompt(
    text: string,
    options?: Pick<
      AgentSessionPromptOptions,
      "preflightResult" | "signal" | "source" | "streamingBehavior"
    >,
  ): Promise<unknown>;
  recoverInterruptedRun(
    options?: AgentSessionRecoveryOptions,
  ): Promise<AgentSessionRecoveryResult>;
  abort(reason?: string): Promise<void>;
  close(): Promise<void>;
}

export interface ServeSessionFactory {
  resolveWorkspace?(
    workspace: string | undefined,
    signal: AbortSignal,
  ): Promise<string>;
  create(
    request: ServeCreateSessionRequest,
    signal: AbortSignal,
  ): Promise<ServeSessionRuntime>;
  open(
    request: ServeOpenSessionRequest,
    signal: AbortSignal,
  ): Promise<ServeSessionRuntime | undefined>;
}

export interface StartServeServerOptions {
  token: string;
  sessionFactory: ServeSessionFactory;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  maxClientsPerSession?: number;
  maxPromptAdmissionBytesPerSession?: number;
  maxPromptAdmissionsPerSession?: number;
  maxReplayBytes?: number;
  maxReplayEvents?: number;
  maxSessions?: number;
}

export interface ServeServer {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

interface ReplayEvent {
  bytes: number;
  frame: string;
  id: number;
}

interface SseQueuedFrame {
  bytes: number;
  frame: string;
}

interface SseClient {
  blockedBytes: number;
  drainTimer: NodeJS.Timeout | undefined;
  onClose: () => void;
  onDrain: () => void;
  queue: SseQueuedFrame[];
  queueBytes: number;
  response: ServerResponse;
  waitingForDrain: boolean;
}

interface PromptAdmissionEntry {
  bytes: number;
  delivery: "steer" | "followUp";
  onAbort: () => void;
  reject: (error: unknown) => void;
  resolve: () => void;
  signal: AbortSignal;
  started: boolean;
  text: string;
}

interface SessionRecord {
  clients: Map<ServerResponse, SseClient>;
  closing: boolean;
  closeFlight?: Promise<void>;
  events: ReplayEvent[];
  latestEventId: number;
  promptAdmissionBytes: number;
  promptAdmissionCancellation: AbortController;
  promptAdmissionDrainWaiters: Set<() => void>;
  promptAdmissionRunning: boolean;
  promptAdmissions: PromptAdmissionEntry[];
  replayBytes: number;
  runtime: ServeSessionRuntime;
  sessionId: string;
  unsubscribe: () => void;
  workspace: string | undefined;
}

interface OpenSessionFlight {
  cancellation: AbortController;
  operation: Promise<SessionRecord | undefined>;
  settled: boolean;
  waiters: number;
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

export function assertValidServeToken(token: string): void {
  const bytes = Buffer.byteLength(token, "utf8");
  if (
    bytes < MIN_SERVE_TOKEN_BYTES ||
    bytes > MAX_SERVE_TOKEN_BYTES ||
    !TOKEN68.test(token)
  ) {
    throw new TypeError(
      "Serve token must contain 32 to 4,096 ASCII token68 characters",
    );
  }
}

function validateHost(host: string): void {
  if (host.trim() === "" || Buffer.byteLength(host, "utf8") > 255 || /[\0\r\n]/u.test(host)) {
    throw new TypeError("Serve host is invalid");
  }
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Serve port must be an integer from 0 to 65,535");
  }
}

function validateString(
  value: unknown,
  name: string,
  options: { allowEmpty?: boolean; maxBytes: number },
): string {
  if (
    typeof value !== "string" ||
    (options.allowEmpty !== true && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > options.maxBytes ||
    value.includes("\0")
  ) {
    throw new HttpProblem(400, `${name} is invalid`);
  }
  return value;
}

function validateSessionId(value: unknown): string {
  if (typeof value !== "string") throw new HttpProblem(400, "sessionId is invalid");
  try {
    assertValidSessionId(value);
  } catch {
    throw new HttpProblem(400, "sessionId is invalid");
  }
  return value;
}

function optionalWorkspace(value: unknown): string | undefined {
  return value === undefined
    ? undefined
    : validateString(value, "workspace", { maxBytes: 4_096 });
}

function recordBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem(400, "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function exactRequestKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  name: string,
): void {
  const keys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !keys.has(key));
  if (unexpected !== undefined) {
    throw new HttpProblem(400, `${name}.${unexpected} is not allowed`);
  }
}

function recoveryRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpProblem(400, `${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function recoveryResolutions(
  body: Readonly<Record<string, unknown>>,
): AgentSessionToolEffectResolution[] | undefined {
  exactRequestKeys(body, ["resolutions"], "Recovery request");
  const value = body["resolutions"];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new HttpProblem(400, "Recovery request.resolutions must be an array");
  }
  if (value.length > MAX_RECOVERY_RESOLUTIONS) {
    throw new HttpProblem(
      400,
      `Recovery request.resolutions cannot exceed ${MAX_RECOVERY_RESOLUTIONS} entries`,
    );
  }
  const effectIds = new Set<string>();
  return value.map((entry, index): AgentSessionToolEffectResolution => {
    const name = `Recovery request.resolutions[${index}]`;
    const resolution = recoveryRecord(entry, name);
    exactRequestKeys(resolution, ["effectId", "outcome", "result"], name);
    const effectId = validateString(resolution["effectId"], `${name}.effectId`, {
      maxBytes: MAX_RECOVERY_EFFECT_ID_BYTES,
    });
    if (effectIds.has(effectId)) {
      throw new HttpProblem(400, `${name}.effectId is duplicated`);
    }
    effectIds.add(effectId);
    const outcome = resolution["outcome"];
    if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "abandoned") {
      throw new HttpProblem(400, `${name}.outcome is invalid`);
    }
    const rawResult = resolution["result"];
    if (outcome === "abandoned") {
      if (rawResult !== undefined) {
        throw new HttpProblem(400, `${name}.result is not allowed for an abandoned effect`);
      }
      return { effectId, outcome };
    }
    if (rawResult === undefined) {
      throw new HttpProblem(400, `${name}.result is required for a ${outcome} effect`);
    }
    const result = recoveryRecord(rawResult, `${name}.result`);
    exactRequestKeys(result, ["content", "isError"], `${name}.result`);
    const content = result["content"];
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content, "utf8") > MAX_TOOL_RESULT_CONTENT_BYTES
    ) {
      throw new HttpProblem(
        400,
        `${name}.result.content must be a string within ${MAX_TOOL_RESULT_CONTENT_BYTES} bytes`,
      );
    }
    const isError = result["isError"];
    if (typeof isError !== "boolean") {
      throw new HttpProblem(400, `${name}.result.isError must be a boolean`);
    }
    if (
      (outcome === "succeeded" && isError) ||
      (outcome === "failed" && !isError)
    ) {
      throw new HttpProblem(400, `${name}.result.isError does not match its outcome`);
    }
    return { effectId, outcome, result: { content, isError } };
  });
}

function isUnsettledRecoveryEffect(
  effect: AgentSessionSuspendedRun["effects"][number],
): boolean {
  return effect.status === "prepared" ||
    effect.status === "dispatched" ||
    effect.status === "in_doubt" ||
    effect.status === "recovery_started";
}

function recoveryStatusPayload(
  value: AgentSessionSuspendedRun | undefined,
): AgentSessionSuspendedRun | null {
  if (value === undefined) return null;
  if (value.claimedQueueIds.length > MAX_RECOVERY_QUEUE_IDS) {
    throw new TypeError("Serve recovery has too many claimed queue entries");
  }
  const effects = value.effects.filter(isUnsettledRecoveryEffect);
  if (effects.length > MAX_RECOVERY_EFFECTS) {
    throw new TypeError("Serve recovery has too many unsettled effects");
  }
  return {
    operationId: value.operationId,
    acceptedAt: value.acceptedAt,
    cancelled: value.cancelled,
    attempts: value.attempts,
    claimedQueueIds: [...value.claimedQueueIds],
    effects: effects.map((effect) => ({ ...effect })),
  };
}

function recoveryResultPayload(value: AgentSessionRecoveryResult): AgentSessionRecoveryResult {
  if (value.blocked.length > MAX_RECOVERY_EFFECTS) {
    throw new TypeError("Serve recovery result has too many blocked effects");
  }
  if (value.recovered) return { recovered: true, operationId: value.operationId, blocked: [] };
  return {
    recovered: false,
    ...(value.operationId === undefined ? {} : { operationId: value.operationId }),
    blocked: value.blocked.map((entry) => ({
      effectId: entry.effectId,
      name: entry.name,
      reason: limitText(entry.reason, MAX_RECOVERY_REASON_BYTES).text,
    })),
  };
}

function contentLength(request: IncomingMessage): number | undefined {
  const header = request.headers["content-length"];
  if (header === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(header)) throw new HttpProblem(400, "Content-Length is invalid");
  const value = Number(header);
  if (!Number.isSafeInteger(value)) throw new HttpProblem(400, "Content-Length is invalid");
  return value;
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  allowEmpty = false,
): Promise<Record<string, unknown>> {
  const declaredLength = contentLength(request);
  if (declaredLength !== undefined && declaredLength > maxBodyBytes) {
    throw new HttpProblem(413, "Request body is too large");
  }

  const contentType = request.headers["content-type"];
  if (
    contentType !== undefined &&
    !/^application\/json(?:\s*;|$)/iu.test(contentType)
  ) {
    throw new HttpProblem(415, "Content-Type must be application/json");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > maxBodyBytes) throw new HttpProblem(413, "Request body is too large");
    chunks.push(chunk);
  }

  if (bytes === 0) {
    if (allowEmpty) return {};
    throw new HttpProblem(400, "Request body is required");
  }
  if (contentType === undefined) throw new HttpProblem(415, "Content-Type must be application/json");

  try {
    return recordBody(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw new HttpProblem(400, "Request body is not valid JSON");
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(payload.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(payload);
}

function summaryString(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`Serve session ${name} is invalid`);
  }
  return value;
}

function statePayload(runtime: ServeSessionRuntime): unknown {
  const summary = runtime.summary;
  if (
    typeof summary !== "object" ||
    summary === null ||
    typeof summary.isStreaming !== "boolean" ||
    typeof summary.isCompacting !== "boolean" ||
    typeof summary.isRetrying !== "boolean" ||
    typeof summary.hasSuspendedRun !== "boolean" ||
    !Number.isSafeInteger(summary.pendingMessageCount) ||
    summary.pendingMessageCount < 0 ||
    !Number.isSafeInteger(summary.messageCount) ||
    summary.messageCount < 0 ||
    !Number.isSafeInteger(summary.toolCount) ||
    summary.toolCount < 0
  ) {
    throw new TypeError("Serve session summary is invalid");
  }
  const model = summary.model === undefined
    ? undefined
    : {
        provider: summaryString(summary.model.provider, "model provider", 256),
        api: summaryString(summary.model.api, "model API", 256),
        id: summaryString(summary.model.id, "model ID", 1_024),
      };
  return {
    sessionId: runtime.sessionId,
    state: {
      ...(model === undefined ? {} : { model }),
      thinkingLevel: summaryString(summary.thinkingLevel, "thinking level", 64),
      isStreaming: summary.isStreaming,
      isCompacting: summary.isCompacting,
      isRetrying: summary.isRetrying,
      pendingMessageCount: summary.pendingMessageCount,
      messageCount: summary.messageCount,
      toolCount: summary.toolCount,
      hasSuspendedRun: summary.hasSuspendedRun,
    },
  };
}

function eventFrame(id: number, envelope: EventEnvelope): string {
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(envelope.event.type)) {
    throw new TypeError("Serve event type is invalid");
  }
  return `id: ${id}\nevent: ${envelope.event.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function replayGapFrame(
  id: number,
  requestedId: number,
  oldestId: number | undefined,
  latestId: number,
): string {
  return `id: ${id}\nevent: replay_gap\ndata: ${JSON.stringify({
    requestedId,
    oldestAvailableId: oldestId ?? null,
    latestId,
  })}\n\n`;
}

function promptDelivery(value: unknown): "steer" | "followUp" {
  if (value === undefined || value === "follow_up") return "followUp";
  if (value === "steer") return "steer";
  throw new HttpProblem(400, "delivery must be steer or follow_up");
}

function lastEventId(request: IncomingMessage): number {
  const header = request.headers["last-event-id"];
  if (header === undefined || header === "") return 0;
  if (Array.isArray(header)) throw new HttpProblem(400, "Last-Event-ID is invalid");
  if (!/^(?:0|[1-9]\d*)$/u.test(header)) {
    throw new HttpProblem(400, "Last-Event-ID is invalid");
  }
  const value = Number(header);
  if (!Number.isSafeInteger(value)) throw new HttpProblem(400, "Last-Event-ID is invalid");
  return value;
}

function waitForOpenFlight(
  flight: OpenSessionFlight,
  signal: AbortSignal,
  onEmpty: () => void,
): Promise<SessionRecord | undefined> {
  signal.throwIfAborted();
  flight.waiters += 1;
  return new Promise<SessionRecord | undefined>((resolveWait, rejectWait) => {
    let waiting = true;
    const leave = (): void => {
      if (!waiting) return;
      waiting = false;
      signal.removeEventListener("abort", onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        onEmpty();
        if (!flight.cancellation.signal.aborted) {
          flight.cancellation.abort(new Error("Serve open has no active waiters"));
        }
      }
    };
    const onAbort = (): void => {
      leave();
      rejectWait(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void flight.operation.then(
      (record) => {
        leave();
        resolveWait(record);
      },
      (error: unknown) => {
        leave();
        rejectWait(error);
      },
    );
  });
}

function openFlightKey(sessionId: string, workspace: string | undefined): string {
  return JSON.stringify([sessionId, workspace ?? null]);
}

class RunningServeServer implements ServeServer {
  readonly #expectedTokenDigest: Buffer;
  readonly #lifecycle = new AbortController();
  readonly #maxBodyBytes: number;
  readonly #maxClientsPerSession: number;
  readonly #maxPromptAdmissionBytesPerSession: number;
  readonly #maxPromptAdmissionsPerSession: number;
  readonly #maxReplayBytes: number;
  readonly #maxReplayEvents: number;
  readonly #maxSessions: number;
  readonly #openFlights = new Map<string, OpenSessionFlight>();
  readonly #sessionFactory: ServeSessionFactory;
  readonly #server: Server;
  readonly #sessions = new Map<string, SessionRecord>();
  #closing = false;
  #closeFlight: Promise<void> | undefined;
  #host: string;
  #pendingSessions = 0;
  #port: number;

  constructor(options: StartServeServerOptions) {
    assertValidServeToken(options.token);
    this.#host = options.host ?? DEFAULT_HOST;
    this.#port = options.port ?? 0;
    validateHost(this.#host);
    validatePort(this.#port);
    this.#expectedTokenDigest = createHash("sha256").update(options.token, "utf8").digest();
    this.#sessionFactory = options.sessionFactory;
    this.#maxBodyBytes = positiveLimit(
      options.maxBodyBytes,
      DEFAULT_MAX_BODY_BYTES,
      "maxBodyBytes",
    );
    this.#maxClientsPerSession = positiveLimit(
      options.maxClientsPerSession,
      DEFAULT_MAX_CLIENTS_PER_SESSION,
      "maxClientsPerSession",
    );
    this.#maxPromptAdmissionBytesPerSession = positiveLimit(
      options.maxPromptAdmissionBytesPerSession,
      DEFAULT_MAX_PROMPT_ADMISSION_BYTES_PER_SESSION,
      "maxPromptAdmissionBytesPerSession",
    );
    this.#maxPromptAdmissionsPerSession = positiveLimit(
      options.maxPromptAdmissionsPerSession,
      DEFAULT_MAX_PROMPT_ADMISSIONS_PER_SESSION,
      "maxPromptAdmissionsPerSession",
    );
    this.#maxReplayBytes = positiveLimit(
      options.maxReplayBytes,
      DEFAULT_MAX_REPLAY_BYTES,
      "maxReplayBytes",
    );
    this.#maxReplayEvents = positiveLimit(
      options.maxReplayEvents,
      DEFAULT_MAX_REPLAY_EVENTS,
      "maxReplayEvents",
    );
    this.#maxSessions = positiveLimit(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
      "maxSessions",
    );
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (response.headersSent || response.destroyed || response.writableEnded) {
          response.destroy();
          return;
        }
        request.resume();
        response.shouldKeepAlive = false;
        if (error instanceof HttpProblem) {
          writeJson(response, error.status, { error: error.message }, {
            Connection: "close",
            ...error.headers,
          });
          return;
        }
        writeJson(response, 500, { error: "Internal server error" }, {
          Connection: "close",
        });
      });
    });
    this.#server.headersTimeout = 10_000;
    this.#server.requestTimeout = 30_000;
    this.#server.keepAliveTimeout = 5_000;
    this.#server.maxRequestsPerSocket = 100;
  }

  get host(): string {
    return this.#host;
  }

  get port(): number {
    return this.#port;
  }

  get origin(): string {
    const bracketedHost = this.#host.includes(":") && !this.#host.startsWith("[")
      ? `[${this.#host}]`
      : this.#host;
    return `http://${bracketedHost}:${this.#port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#port, this.#host);
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Serve server did not expose a TCP address");
    }
    this.#host = (address as AddressInfo).address;
    this.#port = (address as AddressInfo).port;
  }

  close(): Promise<void> {
    this.#closeFlight ??= this.#close();
    return this.#closeFlight;
  }

  async #close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#lifecycle.abort(new Error("Serve server closed"));
    const failures: unknown[] = [];
    const serverClose = new Promise<void>((resolve) => {
      if (!this.#server.listening) {
        resolve();
        return;
      }
      this.#server.close((error) => {
        if (error !== undefined) failures.push(error);
        resolve();
      });
    });

    const records = [...this.#sessions.values()];
    const closeRecords = records.map(async (record) => {
      try {
        await this.#closeRecord(record, "Serve server closed");
      } catch (error) {
        failures.push(error);
      }
    });
    this.#server.closeIdleConnections();
    this.#server.closeAllConnections();
    await Promise.all(closeRecords);
    await serverClose;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Serve server cleanup failed");
  }

  #isAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    const match = authorization === undefined
      ? undefined
      : /^Bearer ([^\s]+)$/iu.exec(authorization);
    const presented = match?.[1] ?? "";
    const digest = createHash("sha256").update(presented, "utf8").digest();
    return match !== undefined && timingSafeEqual(digest, this.#expectedTokenDigest);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const client = new AbortController();
    const abortRequest = (): void => {
      if (!client.signal.aborted) client.abort(new Error("Serve request was aborted"));
    };
    const abortResponse = (): void => {
      if (!response.writableEnded) abortRequest();
    };
    request.once("aborted", abortRequest);
    response.once("close", abortResponse);
    try {
      await this.#dispatch(
        request,
        response,
        AbortSignal.any([this.#lifecycle.signal, client.signal]),
      );
    } finally {
      request.off("aborted", abortRequest);
      response.off("close", abortResponse);
    }
  }

  async #dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#closing) throw new HttpProblem(503, "Serve server is closing");
    if (!this.#isAuthorized(request)) {
      throw new HttpProblem(401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.split("/").filter((segment) => segment !== "");
    const method = request.method ?? "GET";

    if (path.length === 1 && path[0] === "health") {
      if (method !== "GET") throw new HttpProblem(405, "Method not allowed", { Allow: "GET" });
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (path.length === 2 && path[0] === "v1" && path[1] === "sessions") {
      if (method !== "POST") throw new HttpProblem(405, "Method not allowed", { Allow: "POST" });
      const body = await readJsonBody(request, this.#maxBodyBytes);
      const workspace = optionalWorkspace(body["workspace"]);
      const record = await this.#createSession(
        workspace === undefined ? {} : { workspace },
        signal,
      );
      writeJson(response, 201, statePayload(record.runtime));
      return;
    }

    if (
      method === "POST" &&
      path.length === 3 &&
      path[0] === "v1" &&
      path[1] === "sessions" &&
      path[2] === "open"
    ) {
      const body = await readJsonBody(request, this.#maxBodyBytes);
      const sessionId = validateSessionId(body["sessionId"]);
      const workspace = optionalWorkspace(body["workspace"]);
      const record = await this.#openSession({
        sessionId,
        ...(workspace === undefined ? {} : { workspace }),
      }, signal);
      if (record === undefined) throw new HttpProblem(404, "Session not found");
      writeJson(response, 200, statePayload(record.runtime));
      return;
    }

    if (
      path.length >= 3 &&
      path.length <= 4 &&
      path[0] === "v1" &&
      path[1] === "sessions"
    ) {
      let decodedId: string;
      try {
        decodedId = decodeURIComponent(path[2]!);
      } catch {
        throw new HttpProblem(400, "sessionId is invalid");
      }
      const sessionId = validateSessionId(decodedId);
      const record = this.#sessions.get(sessionId);
      if (record === undefined) throw new HttpProblem(404, "Session not found");
      if (record.closing) {
        if (path.length === 3 && method === "DELETE") {
          await this.#closeRecord(record, "Serve session closed");
          writeJson(response, 200, { closed: true, sessionId });
          return;
        }
        throw new HttpProblem(409, "Session is closing");
      }

      if (path.length === 3) {
        if (method === "GET") {
          writeJson(response, 200, statePayload(record.runtime));
          return;
        }
        if (method === "DELETE") {
          await this.#closeRecord(record, "Serve session closed");
          writeJson(response, 200, { closed: true, sessionId });
          return;
        }
        throw new HttpProblem(405, "Method not allowed", { Allow: "DELETE, GET" });
      }

      if (path[3] === "prompts") {
        if (method !== "POST") throw new HttpProblem(405, "Method not allowed", { Allow: "POST" });
        const body = await readJsonBody(request, this.#maxBodyBytes);
        if (record.runtime.suspendedRun !== undefined) {
          throw new HttpProblem(
            409,
            "Session requires interrupted-run recovery before accepting a prompt",
          );
        }
        const text = validateString(body["text"], "text", {
          allowEmpty: true,
          maxBytes: this.#maxBodyBytes,
        });
        await this.#enqueuePrompt(
          record,
          text,
          promptDelivery(body["delivery"]),
          signal,
        );
        writeJson(response, 202, { accepted: true, sessionId });
        return;
      }

      if (path[3] === "cancel") {
        if (method !== "POST") throw new HttpProblem(405, "Method not allowed", { Allow: "POST" });
        const body = await readJsonBody(request, this.#maxBodyBytes, true);
        const reason = body["reason"] === undefined
          ? "Cancelled through serve"
          : validateString(body["reason"], "reason", { allowEmpty: true, maxBytes: 1_024 });
        await record.runtime.abort(reason);
        writeJson(response, 200, { cancelled: true, sessionId });
        return;
      }

      if (path[3] === "recovery") {
        if (method === "GET") {
          writeJson(response, 200, {
            sessionId,
            suspendedRun: recoveryStatusPayload(record.runtime.suspendedRun),
          });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, this.#maxBodyBytes, true);
          const resolutions = recoveryResolutions(body);
          if (resolutions !== undefined && resolutions.length > 0) {
            const suspended = record.runtime.suspendedRun;
            if (suspended === undefined) {
              throw new HttpProblem(409, "Session has no interrupted run to recover");
            }
            const unsettledEffectIds = new Set(
              suspended.effects.filter(isUnsettledRecoveryEffect).map((effect) => effect.effectId),
            );
            if (resolutions.some((resolution) => !unsettledEffectIds.has(resolution.effectId))) {
              throw new HttpProblem(
                409,
                "A recovery resolution does not identify an unsettled effect in this operation",
              );
            }
          }
          const recovery = await record.runtime.recoverInterruptedRun({
            signal,
            ...(resolutions === undefined ? {} : { resolutions }),
          });
          writeJson(response, 200, {
            sessionId,
            recovery: recoveryResultPayload(recovery),
          });
          return;
        }
        throw new HttpProblem(405, "Method not allowed", { Allow: "GET, POST" });
      }

      if (path[3] === "events") {
        if (method !== "GET") throw new HttpProblem(405, "Method not allowed", { Allow: "GET" });
        if (record.clients.size >= this.#maxClientsPerSession) {
          throw new HttpProblem(503, "Event stream capacity reached");
        }
        this.#openEventStream(request, response, record);
        return;
      }
    }

    throw new HttpProblem(404, "Not found");
  }

  async #withSessionCapacity<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#sessions.size + this.#pendingSessions >= this.#maxSessions) {
      throw new HttpProblem(503, "Session capacity reached");
    }
    this.#pendingSessions += 1;
    try {
      return await operation();
    } finally {
      this.#pendingSessions -= 1;
    }
  }

  async #createSession(
    request: ServeCreateSessionRequest,
    signal: AbortSignal,
  ): Promise<SessionRecord> {
    const workspace = await this.#resolveWorkspace(request.workspace, signal);
    return await this.#withSessionCapacity(async () => {
      signal.throwIfAborted();
      const runtime = await this.#sessionFactory.create(
        workspace === undefined ? {} : { workspace },
        signal,
      );
      return await this.#register(runtime, workspace, signal);
    });
  }

  async #openSession(
    request: ServeOpenSessionRequest,
    signal: AbortSignal,
  ): Promise<SessionRecord | undefined> {
    const workspace = await this.#resolveWorkspace(request.workspace, signal);
    const existing = this.#sessions.get(request.sessionId);
    if (existing !== undefined) {
      if (existing.closing) throw new HttpProblem(409, "Session is closing");
      this.#assertWorkspace(existing, workspace);
      return existing;
    }
    const key = openFlightKey(request.sessionId, workspace);
    const active = this.#openFlights.get(key);
    if (active !== undefined) {
      return await waitForOpenFlight(active, signal, () => {
        if (this.#openFlights.get(key) === active) this.#openFlights.delete(key);
      });
    }

    const cancellation = new AbortController();
    const operationSignal = AbortSignal.any([
      this.#lifecycle.signal,
      cancellation.signal,
    ]);
    const operation = this.#withSessionCapacity(async () => {
      const registered = this.#sessions.get(request.sessionId);
      if (registered !== undefined) {
        this.#assertWorkspace(registered, workspace);
        return registered;
      }
      operationSignal.throwIfAborted();
      const runtime = await this.#sessionFactory.open({
        sessionId: request.sessionId,
        ...(workspace === undefined ? {} : { workspace }),
      }, operationSignal);
      if (runtime === undefined) return undefined;
      if (runtime.sessionId !== request.sessionId) {
        await this.#closeUnregistered(runtime);
        throw new Error("Opened session ID does not match the requested session");
      }
      return await this.#register(runtime, workspace, operationSignal);
    });
    const flight: OpenSessionFlight = {
      cancellation,
      operation,
      settled: false,
      waiters: 0,
    };
    this.#openFlights.set(key, flight);
    void operation.then(
      () => {
        flight.settled = true;
        if (this.#openFlights.get(key) === flight) this.#openFlights.delete(key);
      },
      () => {
        flight.settled = true;
        if (this.#openFlights.get(key) === flight) this.#openFlights.delete(key);
      },
    );
    return await waitForOpenFlight(flight, signal, () => {
      if (this.#openFlights.get(key) === flight) this.#openFlights.delete(key);
    });
  }

  async #resolveWorkspace(
    workspace: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    if (this.#sessionFactory.resolveWorkspace === undefined) return workspace;
    const resolved = await this.#sessionFactory.resolveWorkspace(workspace, signal);
    signal.throwIfAborted();
    return validateString(resolved, "workspace", { maxBytes: 4_096 });
  }

  #assertWorkspace(record: SessionRecord, workspace: string | undefined): void {
    if (record.workspace !== workspace) {
      throw new HttpProblem(409, "Session is already open in another workspace");
    }
  }

  async #register(
    runtime: ServeSessionRuntime,
    workspace: string | undefined,
    signal: AbortSignal,
  ): Promise<SessionRecord> {
    try {
      validateSessionId(runtime.sessionId);
    } catch (error) {
      await this.#closeUnregistered(runtime);
      throw error;
    }
    if (this.#closing || signal.aborted) {
      await this.#closeUnregistered(runtime);
      throw new HttpProblem(503, "Serve server is closing");
    }
    const existing = this.#sessions.get(runtime.sessionId);
    if (existing?.runtime === runtime) {
      this.#assertWorkspace(existing, workspace);
      return existing;
    }
    if (existing !== undefined) {
      await this.#closeUnregistered(runtime);
      this.#assertWorkspace(existing, workspace);
      throw new HttpProblem(409, "Session is already open");
    }
    const record: SessionRecord = {
      clients: new Map(),
      closing: false,
      events: [],
      latestEventId: 0,
      promptAdmissionBytes: 0,
      promptAdmissionCancellation: new AbortController(),
      promptAdmissionDrainWaiters: new Set(),
      promptAdmissionRunning: false,
      promptAdmissions: [],
      replayBytes: 0,
      runtime,
      sessionId: runtime.sessionId,
      unsubscribe: () => undefined,
      workspace,
    };
    try {
      record.unsubscribe = runtime.onEvent((event) => {
        this.#publish(record, event);
      });
      await runtime.start?.(signal);
      signal.throwIfAborted();
    } catch (error) {
      try {
        record.unsubscribe();
      } catch {
        // The original startup error remains authoritative.
      }
      await this.#closeUnregistered(runtime);
      throw error;
    }
    if (this.#closing) {
      try {
        record.unsubscribe();
      } catch {
        // Closing the runtime remains mandatory.
      }
      await this.#closeUnregistered(runtime);
      throw new HttpProblem(503, "Serve server is closing");
    }
    const startedExisting = this.#sessions.get(runtime.sessionId);
    if (startedExisting?.runtime === runtime) {
      record.unsubscribe();
      this.#assertWorkspace(startedExisting, workspace);
      return startedExisting;
    }
    if (startedExisting !== undefined) {
      record.unsubscribe();
      await this.#closeUnregistered(runtime);
      this.#assertWorkspace(startedExisting, workspace);
      throw new HttpProblem(409, "Session is already open");
    }
    this.#sessions.set(runtime.sessionId, record);
    return record;
  }

  #enqueuePrompt(
    record: SessionRecord,
    text: string,
    delivery: "steer" | "followUp",
    requestSignal: AbortSignal,
  ): Promise<void> {
    if (record.closing) throw new HttpProblem(409, "Session is closing");
    const signal = AbortSignal.any([
      requestSignal,
      record.promptAdmissionCancellation.signal,
    ]);
    signal.throwIfAborted();
    const bytes = Buffer.byteLength(text, "utf8");
    if (
      record.promptAdmissions.length >= this.#maxPromptAdmissionsPerSession ||
      record.promptAdmissionBytes + bytes > this.#maxPromptAdmissionBytesPerSession
    ) {
      throw new HttpProblem(503, "Prompt admission capacity reached");
    }

    return new Promise<void>((resolve, reject) => {
      const entry: PromptAdmissionEntry = {
        bytes,
        delivery,
        onAbort: () => undefined,
        reject,
        resolve,
        signal,
        started: false,
        text,
      };
      entry.onAbort = () => {
        if (entry.started || !this.#releasePromptAdmission(record, entry)) return;
        reject(signal.reason);
        this.#drainPromptAdmissions(record);
      };
      record.promptAdmissions.push(entry);
      record.promptAdmissionBytes += bytes;
      signal.addEventListener("abort", entry.onAbort, { once: true });
      if (signal.aborted) entry.onAbort();
      else this.#drainPromptAdmissions(record);
    });
  }

  #drainPromptAdmissions(record: SessionRecord): void {
    if (record.promptAdmissionRunning) return;
    for (;;) {
      const entry = record.promptAdmissions[0];
      if (entry === undefined) {
        this.#notifyPromptAdmissionDrain(record);
        return;
      }
      if (entry.signal.aborted || record.closing) {
        const error = entry.signal.aborted
          ? entry.signal.reason
          : new HttpProblem(409, "Session is closing");
        if (this.#releasePromptAdmission(record, entry)) entry.reject(error);
        continue;
      }
      entry.started = true;
      entry.signal.removeEventListener("abort", entry.onAbort);
      record.promptAdmissionRunning = true;
      void this.#admitPrompt(
        record,
        entry.text,
        entry.delivery,
        entry.signal,
      ).then(
        () => this.#finishPromptAdmission(record, entry, { accepted: true }),
        (error: unknown) => this.#finishPromptAdmission(record, entry, { error }),
      );
      return;
    }
  }

  #finishPromptAdmission(
    record: SessionRecord,
    entry: PromptAdmissionEntry,
    result: { accepted: true } | { error: unknown },
  ): void {
    if (!this.#releasePromptAdmission(record, entry)) return;
    record.promptAdmissionRunning = false;
    if ("error" in result) entry.reject(result.error);
    else entry.resolve();
    this.#drainPromptAdmissions(record);
  }

  #releasePromptAdmission(
    record: SessionRecord,
    entry: PromptAdmissionEntry,
  ): boolean {
    const index = record.promptAdmissions.indexOf(entry);
    if (index < 0) return false;
    record.promptAdmissions.splice(index, 1);
    record.promptAdmissionBytes -= entry.bytes;
    entry.signal.removeEventListener("abort", entry.onAbort);
    return true;
  }

  #notifyPromptAdmissionDrain(record: SessionRecord): void {
    if (record.promptAdmissionRunning || record.promptAdmissions.length > 0) return;
    for (const resolve of record.promptAdmissionDrainWaiters) resolve();
    record.promptAdmissionDrainWaiters.clear();
  }

  async #waitForPromptAdmissionDrain(record: SessionRecord): Promise<void> {
    if (!record.promptAdmissionRunning && record.promptAdmissions.length === 0) return;
    await new Promise<void>((resolve) => {
      record.promptAdmissionDrainWaiters.add(resolve);
    });
  }

  async #admitPrompt(
    record: SessionRecord,
    text: string,
    delivery: "steer" | "followUp",
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    let reported = false;
    let resolveAdmission!: () => void;
    let rejectAdmission!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    const report = (succeeded: boolean): void => {
      if (reported) return;
      reported = true;
      if (succeeded) resolveAdmission();
      else rejectAdmission(new HttpProblem(409, "Prompt was not accepted"));
    };
    const onAbort = (): void => {
      if (!reported) rejectAdmission(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const run = Promise.resolve().then(async () =>
      await record.runtime.prompt(text, {
        source: "serve",
        streamingBehavior: delivery,
        preflightResult: report,
        signal,
      })
    );
    void run.then(
      () => {
        if (!reported) {
          rejectAdmission(new Error("Serve session prompt completed without admission"));
        }
      },
      (error: unknown) => {
        if (!reported) rejectAdmission(error);
      },
    );
    try {
      await admission;
    } catch (error) {
      if (signal.aborted) await run.then(() => undefined, () => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #closeUnregistered(runtime: ServeSessionRuntime): Promise<void> {
    try {
      await runtime.abort("Serve session was not accepted");
    } catch {
      // Closing the runtime remains mandatory even when cancellation fails.
    }
    try {
      await runtime.close();
    } catch {
      // The original registration error is more useful to the caller.
    }
  }

  #closeRecord(record: SessionRecord, reason: string): Promise<void> {
    if (record.closeFlight === undefined) {
      record.closing = true;
      record.closeFlight = this.#closeRecordOnce(record, reason);
    }
    return record.closeFlight;
  }

  async #closeRecordOnce(record: SessionRecord, reason: string): Promise<void> {
    const failures: unknown[] = [];
    try {
      try {
        record.unsubscribe();
      } catch (error) {
        failures.push(error);
      }
      for (const client of [...record.clients.values()]) {
        this.#removeSseClient(record, client, false);
        try {
          client.response.end();
        } catch (error) {
          failures.push(error);
          client.response.destroy();
        }
      }
      record.clients.clear();
      record.promptAdmissionCancellation.abort(new HttpProblem(409, "Session is closing"));
      const abortFlight = record.runtime.abort(reason).catch((error: unknown) => {
        failures.push(error);
      });
      await Promise.all([this.#waitForPromptAdmissionDrain(record), abortFlight]);
      try {
        await record.runtime.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Serve session cleanup failed");
      }
    } finally {
      if (this.#sessions.get(record.sessionId) === record) {
        this.#sessions.delete(record.sessionId);
      }
    }
  }

  #removeSseClient(record: SessionRecord, client: SseClient, destroy: boolean): void {
    if (record.clients.get(client.response) !== client) return;
    record.clients.delete(client.response);
    if (client.drainTimer !== undefined) {
      clearTimeout(client.drainTimer);
      client.drainTimer = undefined;
    }
    client.response.off("close", client.onClose);
    client.response.off("error", client.onClose);
    client.response.off("drain", client.onDrain);
    client.queue.length = 0;
    client.queueBytes = 0;
    client.blockedBytes = 0;
    client.waitingForDrain = false;
    if (destroy && !client.response.destroyed) client.response.destroy();
  }

  #waitForSseDrain(record: SessionRecord, client: SseClient, blockedBytes: number): boolean {
    client.blockedBytes = blockedBytes;
    if (client.blockedBytes + client.queueBytes > MAX_SSE_QUEUE_BYTES) {
      this.#removeSseClient(record, client, true);
      return false;
    }
    client.waitingForDrain = true;
    client.response.once("drain", client.onDrain);
    client.drainTimer = setTimeout(() => {
      this.#removeSseClient(record, client, true);
    }, SSE_DRAIN_TIMEOUT_MS);
    client.drainTimer.unref();
    return true;
  }

  #flushSseQueue(record: SessionRecord, client: SseClient): void {
    if (record.clients.get(client.response) !== client) return;
    if (client.drainTimer !== undefined) {
      clearTimeout(client.drainTimer);
      client.drainTimer = undefined;
    }
    client.waitingForDrain = false;
    client.blockedBytes = 0;
    while (client.queue.length > 0) {
      const queued = client.queue.shift()!;
      client.queueBytes -= queued.bytes;
      if (!this.#writeSse(record, client, queued.frame) || client.waitingForDrain) return;
    }
  }

  #writeSse(record: SessionRecord, client: SseClient, frame: string): boolean {
    const { response } = client;
    if (response.destroyed || response.writableEnded) {
      this.#removeSseClient(record, client, false);
      return false;
    }
    const bytes = Buffer.byteLength(frame, "utf8");
    if (bytes > MAX_SSE_QUEUE_BYTES) {
      this.#removeSseClient(record, client, true);
      return false;
    }
    if (client.waitingForDrain) {
      if (
        client.queue.length >= MAX_SSE_QUEUE_EVENTS ||
        client.blockedBytes + client.queueBytes + bytes > MAX_SSE_QUEUE_BYTES
      ) {
        this.#removeSseClient(record, client, true);
        return false;
      }
      client.queue.push({ bytes, frame });
      client.queueBytes += bytes;
      return true;
    }
    try {
      if (response.write(frame)) return true;
      return this.#waitForSseDrain(
        record,
        client,
        Math.max(bytes, response.writableLength),
      );
    } catch {
      // A failed stream is isolated from the session and other clients.
    }
    this.#removeSseClient(record, client, true);
    return false;
  }

  #publish(record: SessionRecord, envelope: EventEnvelope): void {
    try {
      const id = record.latestEventId + 1;
      const frame = eventFrame(id, envelope);
      const replayEvent = { bytes: Buffer.byteLength(frame, "utf8"), frame, id };
      record.latestEventId = id;
      record.events.push(replayEvent);
      record.replayBytes += replayEvent.bytes;
      while (
        record.events.length > this.#maxReplayEvents ||
        record.replayBytes > this.#maxReplayBytes
      ) {
        const removed = record.events.shift();
        if (removed === undefined) break;
        record.replayBytes -= removed.bytes;
      }
      for (const client of [...record.clients.values()]) {
        this.#writeSse(record, client, frame);
      }
    } catch {
      // Runtime event delivery must not fail the session.
    }
  }

  #openEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    record: SessionRecord,
  ): void {
    const requestedId = lastEventId(request);
    if (requestedId > record.latestEventId) {
      throw new HttpProblem(409, "Last-Event-ID is ahead of the event stream");
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    response.flushHeaders();
    const client: SseClient = {
      blockedBytes: 0,
      drainTimer: undefined,
      onClose: () => undefined,
      onDrain: () => undefined,
      queue: [],
      queueBytes: 0,
      response,
      waitingForDrain: false,
    };
    client.onClose = () => this.#removeSseClient(record, client, false);
    client.onDrain = () => this.#flushSseQueue(record, client);
    record.clients.set(response, client);
    response.once("close", client.onClose);
    response.once("error", client.onClose);
    if (!this.#writeSse(record, client, "retry: 1000\n\n")) return;

    const oldestId = record.events[0]?.id;
    const replayGap = record.latestEventId > requestedId && (
      oldestId === undefined || requestedId < oldestId - 1
    );
    if (replayGap) {
      const gapId = (oldestId ?? record.latestEventId + 1) - 1;
      if (!this.#writeSse(
        record,
        client,
        replayGapFrame(gapId, requestedId, oldestId, record.latestEventId),
      )) {
        return;
      }
    }
    const effectiveRequestedId = replayGap ? (oldestId ?? record.latestEventId + 1) - 1 : requestedId;
    for (const event of record.events) {
      if (
        event.id > effectiveRequestedId &&
        !this.#writeSse(record, client, event.frame)
      ) {
        return;
      }
    }
  }
}

export async function startServeServer(
  options: StartServeServerOptions,
): Promise<ServeServer> {
  const server = new RunningServeServer(options);
  await server.start();
  return server;
}
