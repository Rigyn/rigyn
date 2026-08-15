import { randomBytes } from "node:crypto";

import type { EventEnvelope, RuntimeEvent } from "./events.js";
import type { JsonValue } from "./json.js";
import type { CanonicalMessage, NormalizedUsage } from "./types.js";
import { defaultSecretRedactor } from "../auth/redaction.js";

export type ObservabilityLevel = "off" | "error" | "info" | "debug";
export type ObservabilityMode = "interactive" | "print" | "json" | "rpc" | "serve" | "sdk";
export type ObservabilityArea =
  | "startup"
  | "runtime"
  | "provider"
  | "tool"
  | "session"
  | "extension"
  | "tui"
  | "rpc"
  | "serve"
  | "sdk";
export type ObservabilityField = string | number | boolean | null;
export type ObservabilityFields = Readonly<Record<string, ObservabilityField>>;

export interface ObservabilityCorrelation {
  session?: string;
  run?: string;
  request?: string;
}

export interface ObservabilityRecord {
  schemaVersion: 1;
  kind: "event" | "metrics_snapshot";
  timestamp: string;
  processInstance: string;
  mode: ObservabilityMode;
  level: Exclude<ObservabilityLevel, "off">;
  area: ObservabilityArea;
  name: string;
  correlation?: ObservabilityCorrelation;
  fields: ObservabilityFields;
}

export interface ObservabilitySink {
  record(record: ObservabilityRecord): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeObservabilityOptions {
  level?: ObservabilityLevel;
  mode: ObservabilityMode;
  now?: () => Date;
  processInstance?: string;
  snapshotIntervalMs?: number;
  /** Close the sink with this observer. SDK callers normally retain sink ownership. */
  closeSink?: boolean;
}

interface ToolObservation {
  runId?: string;
  active: boolean;
  startedAt?: number;
  updates: number;
  stdoutBytes: number;
  stderrBytes: number;
  producedBytes: number;
  truncated: boolean;
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  serverToolCalls: number;
  durationMs: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
}

interface UsageTelemetryScope {
  hasUsage: boolean;
  completed: boolean;
  inputComplete: boolean;
  inputOverflowed: boolean;
  outputComplete: boolean;
  outputOverflowed: boolean;
  totalComplete: boolean;
  totalOverflowed: boolean;
  readComplete: boolean;
  readOverflowed: boolean;
  writeComplete: boolean;
  writeOverflowed: boolean;
  costComplete: boolean;
  costOverflowed: boolean;
}

interface RuntimeMetrics extends UsageAccumulator {
  inputTokensObserved: boolean;
  inputTokensComplete: boolean;
  outputTokensObserved: boolean;
  outputTokensComplete: boolean;
  totalTokensObserved: boolean;
  totalTokensComplete: boolean;
  cacheTelemetryObserved: boolean;
  cacheReadTokensObserved: boolean;
  cacheWriteTokensObserved: boolean;
  cacheReadTokensComplete: boolean;
  cacheWriteTokensComplete: boolean;
  usageTelemetryScopes: number;
  costObserved: boolean;
  costComplete: boolean;
  providerDurationObserved: boolean;
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  runsCancelled: number;
  providerAttempts: number;
  providerRetries: number;
  toolsStarted: number;
  toolsCompleted: number;
  toolsFailed: number;
  toolsInDoubt: number;
  compactionsStarted: number;
  compactionsCompleted: number;
  compactionsFailed: number;
  branchSummaries: number;
  warnings: number;
  activeRuns: number;
  activeTools: number;
}

const LEVEL_ORDER: Readonly<Record<ObservabilityLevel, number>> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3,
};
const MAX_IDENTIFIER_BYTES = 512;
const MAX_METADATA_TOKEN_BYTES = 256;
const MAX_SESSION_ALIASES = 1_024;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const FAILURE_CATEGORIES = new Set([
  "authentication",
  "permission",
  "rate_limit",
  "invalid_request",
  "not_found",
  "overloaded",
  "network",
  "timeout",
  "protocol",
  "cancelled",
  "provider",
  "internal",
]);
const WARNING_CODES = new Set([
  "manual_compaction_skipped",
  "context_tool_results_bounded",
  "provider_context_limit",
  "extension_model_after",
  "extension_run_after",
  "extension_compaction_after",
  "unknown_provider_event",
]);

export function resolveObservabilityLevel(
  configured: ObservabilityLevel = "debug",
  environment: NodeJS.ProcessEnv = process.env,
): ObservabilityLevel {
  const override = environment.RIGYN_LOG_LEVEL;
  if (override === undefined || override === "") return configured;
  if (override === "off" || override === "error" || override === "info" || override === "debug") return override;
  throw new Error("RIGYN_LOG_LEVEL must be off, error, info, or debug");
}

function emptyUsage(): UsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    serverToolCalls: 0,
    durationMs: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
  };
}

function emptyMetrics(): RuntimeMetrics {
  return {
    ...emptyUsage(),
    inputTokensObserved: false,
    inputTokensComplete: true,
    outputTokensObserved: false,
    outputTokensComplete: true,
    totalTokensObserved: false,
    totalTokensComplete: true,
    cacheTelemetryObserved: false,
    cacheReadTokensObserved: false,
    cacheWriteTokensObserved: false,
    cacheReadTokensComplete: true,
    cacheWriteTokensComplete: true,
    usageTelemetryScopes: 0,
    costObserved: false,
    costComplete: true,
    providerDurationObserved: false,
    runsStarted: 0,
    runsCompleted: 0,
    runsFailed: 0,
    runsCancelled: 0,
    providerAttempts: 0,
    providerRetries: 0,
    toolsStarted: 0,
    toolsCompleted: 0,
    toolsFailed: 0,
    toolsInDoubt: 0,
    compactionsStarted: 0,
    compactionsCompleted: 0,
    compactionsFailed: 0,
    branchSummaries: 0,
    warnings: 0,
    activeRuns: 0,
    activeTools: 0,
  };
}

function utf8Prefix(value: string, maximum: number): string {
  const selected = value.replaceAll("\0", "").replace(/[\r\n\t]/gu, " ");
  const bytes = Buffer.from(selected, "utf8");
  if (bytes.length <= maximum) return selected;
  return bytes.subarray(0, maximum).toString("utf8").replace(/\uFFFD$/u, "");
}

function safeFields(fields: ObservabilityFields): ObservabilityFields {
  const selected: Record<string, ObservabilityField> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) continue;
    if (typeof value === "string") selected[key] = utf8Prefix(defaultSecretRedactor.redact(value), MAX_IDENTIFIER_BYTES);
    else if (typeof value === "number") {
      if (Number.isFinite(value)) selected[key] = value;
    } else if (typeof value === "boolean" || value === null) selected[key] = value;
  }
  return Object.freeze(selected);
}

function byteLength(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, "utf8");
}

function jsonByteLength(value: JsonValue | undefined): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function failureCategory(value: string): string {
  return FAILURE_CATEGORIES.has(value) ? value : "provider";
}

function warningCode(value: string): string {
  return WARNING_CODES.has(value) ? value : "runtime_warning";
}

function metadataToken(value: string | undefined): string | undefined {
  if (
    value === undefined
    || Buffer.byteLength(value, "utf8") > MAX_METADATA_TOKEN_BYTES
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*={0,2}$/u.test(value)
  ) return undefined;
  return value;
}

function mediaType(value: string | undefined): string | undefined {
  if (value === undefined || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES) return undefined;
  const selected = value.split(";", 1)[0]?.trim();
  if (
    selected === undefined
    || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(selected)
  ) return undefined;
  return selected.toLowerCase();
}

function usageFields(usage: NormalizedUsage | undefined, prefix = ""): ObservabilityFields {
  if (usage === undefined) return {};
  const field = (name: string): string => `${prefix}${name}`;
  return {
    ...(usage.inputTokens === undefined ? {} : { [field("input_tokens")]: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { [field("output_tokens")]: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { [field("total_tokens")]: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { [field("cache_read_tokens")]: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { [field("cache_write_tokens")]: usage.cacheWriteTokens }),
    ...(usage.cacheWrite1hTokens === undefined ? {} : { [field("cache_write_1h_tokens")]: usage.cacheWrite1hTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { [field("reasoning_tokens")]: usage.reasoningTokens }),
    ...(usage.serverToolCalls === undefined ? {} : { [field("server_tool_calls")]: usage.serverToolCalls }),
    ...(usage.durationMs === undefined ? {} : { [field("duration_ms")]: usage.durationMs }),
    ...(usage.cost === undefined
      ? {}
      : {
          [field("cost_input")]: usage.cost.input,
          [field("cost_output")]: usage.cost.output,
          [field("cost_cache_read")]: usage.cost.cacheRead,
          [field("cost_cache_write")]: usage.cost.cacheWrite,
          [field("cost_total")]: usage.cost.total,
        }),
  };
}

function numericUsage(usage: NormalizedUsage | undefined): UsageAccumulator {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    cacheWrite1hTokens: usage?.cacheWrite1hTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    serverToolCalls: usage?.serverToolCalls ?? 0,
    durationMs: usage?.durationMs ?? 0,
    costInput: usage?.cost?.input ?? 0,
    costOutput: usage?.cost?.output ?? 0,
    costCacheRead: usage?.cost?.cacheRead ?? 0,
    costCacheWrite: usage?.cost?.cacheWrite ?? 0,
    costTotal: usage?.cost?.total ?? 0,
  };
}

const COMPLETE_USAGE_FIELDS = [
  ["inputTokens", "inputComplete", "inputOverflowed"],
  ["outputTokens", "outputComplete", "outputOverflowed"],
  ["totalTokens", "totalComplete", "totalOverflowed"],
  ["cacheReadTokens", "readComplete", "readOverflowed"],
  ["cacheWriteTokens", "writeComplete", "writeOverflowed"],
] as const;

const AUXILIARY_USAGE_FIELDS = [
  "cacheWrite1hTokens",
  "reasoningTokens",
  "serverToolCalls",
  "durationMs",
] as const satisfies readonly (keyof UsageAccumulator)[];

const COST_COMPONENT_FIELDS = [
  "costInput",
  "costOutput",
  "costCacheRead",
  "costCacheWrite",
] as const satisfies readonly (keyof UsageAccumulator)[];

function emptyUsageTelemetryScope(): UsageTelemetryScope {
  return {
    hasUsage: false,
    completed: false,
    inputComplete: false,
    inputOverflowed: false,
    outputComplete: false,
    outputOverflowed: false,
    totalComplete: false,
    totalOverflowed: false,
    readComplete: false,
    readOverflowed: false,
    writeComplete: false,
    writeOverflowed: false,
    costComplete: false,
    costOverflowed: false,
  };
}

function reconcileUsageInteger(
  target: UsageAccumulator,
  accounted: UsageAccumulator,
  field: keyof UsageAccumulator,
  next: number,
  incremental: boolean,
): boolean {
  if (!Number.isSafeInteger(next) || next < 0) return false;
  if (incremental) {
    const targetValue = target[field] + next;
    const accountedValue = accounted[field] + next;
    if (!Number.isSafeInteger(targetValue) || !Number.isSafeInteger(accountedValue)) return false;
    target[field] = targetValue;
    accounted[field] = accountedValue;
    return true;
  }
  const retained = target[field] - accounted[field];
  const targetValue = retained + next;
  if (!Number.isSafeInteger(retained) || retained < 0 || !Number.isSafeInteger(targetValue)) return false;
  target[field] = targetValue;
  accounted[field] = next;
  return true;
}

function reconcileUsageCost(
  target: UsageAccumulator,
  accounted: UsageAccumulator,
  next: UsageAccumulator,
  incremental: boolean,
): boolean {
  const targetValues = new Map<keyof UsageAccumulator, number>();
  const accountedValues = new Map<keyof UsageAccumulator, number>();
  for (const field of COST_COMPONENT_FIELDS) {
    const nextValue = next[field];
    if (!Number.isFinite(nextValue) || nextValue < 0) return false;
    const targetValue = incremental
      ? target[field] + nextValue
      : target[field] - accounted[field] + nextValue;
    const accountedValue = incremental ? accounted[field] + nextValue : nextValue;
    if (
      !Number.isFinite(targetValue)
      || targetValue < 0
      || !Number.isFinite(accountedValue)
      || accountedValue < 0
    ) return false;
    targetValues.set(field, targetValue);
    accountedValues.set(field, accountedValue);
  }
  const targetComponents = COST_COMPONENT_FIELDS.reduce((sum, field) => sum + targetValues.get(field)!, 0);
  const accountedComponents = COST_COMPONENT_FIELDS.reduce((sum, field) => sum + accountedValues.get(field)!, 0);
  const targetTotal = incremental
    ? target.costTotal + next.costTotal
    : target.costTotal - accounted.costTotal + next.costTotal;
  const accountedTotal = incremental ? accounted.costTotal + next.costTotal : next.costTotal;
  const coherent = (total: number, components: number): boolean =>
    Number.isFinite(total)
    && total >= 0
    && Number.isFinite(components)
    && Math.abs(total - components) <= Math.max(1e-12, Math.abs(total) * 1e-9);
  if (!coherent(targetTotal, targetComponents) || !coherent(accountedTotal, accountedComponents)) return false;
  for (const field of COST_COMPONENT_FIELDS) {
    target[field] = targetValues.get(field)!;
    accounted[field] = accountedValues.get(field)!;
  }
  target.costTotal = targetTotal;
  accounted.costTotal = accountedTotal;
  return true;
}

function messageFields(message: CanonicalMessage): ObservabilityFields {
  let textBlocks = 0;
  let reasoningBlocks = 0;
  let imageBlocks = 0;
  let toolCallBlocks = 0;
  let toolResultBlocks = 0;
  let opaqueBlocks = 0;
  let payloadBytes = 0;
  for (const block of message.content) {
    switch (block.type) {
      case "text": textBlocks += 1; payloadBytes += byteLength(block.text); break;
      case "thinking": reasoningBlocks += 1; payloadBytes += byteLength(block.thinking); break;
      case "image": imageBlocks += 1; payloadBytes += byteLength(block.data ?? block.url); break;
      case "tool_call": toolCallBlocks += 1; payloadBytes += jsonByteLength(block.arguments); break;
      case "tool_result":
        toolResultBlocks += 1;
        payloadBytes += byteLength(block.content);
        break;
      case "provider_opaque": opaqueBlocks += 1; break;
    }
  }
  return {
    role: message.role,
    text_blocks: textBlocks,
    reasoning_blocks: reasoningBlocks,
    image_blocks: imageBlocks,
    tool_call_blocks: toolCallBlocks,
    tool_result_blocks: toolResultBlocks,
    opaque_blocks: opaqueBlocks,
    payload_bytes: payloadBytes,
  };
}

function runFailureFields(event: Extract<RuntimeEvent, { type: "run_failed" }>): ObservabilityFields {
  if (event.error.category === "internal") {
    return { category: "internal", internal: true };
  }
  const diagnostics = event.error.diagnostics;
  const diagnosticRequestId = diagnostics?.headers["request-id"]
    ?? diagnostics?.headers["x-request-id"]
    ?? diagnostics?.headers["apim-request-id"]
    ?? diagnostics?.headers["x-amzn-requestid"]
    ?? diagnostics?.headers["x-amzn-request-id"]
    ?? diagnostics?.headers["x-goog-request-id"];
  const providerCode = metadataToken(event.error.providerCode);
  const requestId = metadataToken(event.error.requestId);
  const responseContentType = mediaType(diagnostics?.headers["content-type"]);
  const responseRequestId = metadataToken(diagnosticRequestId);
  const responseEdgeId = metadataToken(diagnostics?.headers["cf-ray"]);
  return {
    category: failureCategory(event.error.category),
    internal: false,
    retryable: event.error.retryable,
    partial: event.error.partial,
    ...(event.error.httpStatus === undefined ? {} : { http_status: event.error.httpStatus }),
    ...(providerCode === undefined ? {} : { provider_code: providerCode }),
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(event.error.retryAfterMs === undefined ? {} : { retry_after_ms: event.error.retryAfterMs }),
    ...(event.error.bodyStarted === undefined ? {} : { response_started: event.error.bodyStarted }),
    ...(diagnostics?.status === 101
      ? { websocket_handshake_status: diagnostics.status }
      : diagnostics === undefined ? {} : { response_status: diagnostics.status }),
    ...(responseContentType === undefined ? {} : { response_content_type: responseContentType }),
    ...(responseRequestId === undefined ? {} : { response_request_id: responseRequestId }),
    ...(responseEdgeId === undefined ? {} : { response_edge_id: responseEdgeId }),
  };
}

/**
 * Bounded runtime observability. Callers may add only preselected scalar metadata;
 * arbitrary events, request objects, and extension values are never serialized.
 */
export class RuntimeObservability {
  readonly #sink: ObservabilitySink;
  readonly #mode: ObservabilityMode;
  readonly #now: () => Date;
  readonly #processInstance: string;
  readonly #metrics = emptyMetrics();
  readonly #sessionAliases = new Map<string, string>();
  readonly #runAliases = new Map<string, string>();
  readonly #runStarted = new Map<string, number>();
  readonly #toolObservations = new Map<string, ToolObservation>();
  readonly #compactionStarted = new Map<string, number>();
  readonly #accountedUsage = new Map<string, UsageAccumulator>();
  readonly #usageTelemetryScopes = new Map<string, UsageTelemetryScope>();
  readonly #snapshotTimer: ReturnType<typeof setInterval>;
  readonly #closeSink: boolean;
  #level: ObservabilityLevel;
  #sessionOrdinal = 0;
  #runOrdinal = 0;
  #closed = false;
  #closeFlight: Promise<void> | undefined;

  constructor(sink: ObservabilitySink, options: RuntimeObservabilityOptions) {
    this.#sink = sink;
    this.#mode = options.mode;
    this.#level = options.level ?? "debug";
    this.#now = options.now ?? (() => new Date());
    this.#processInstance = options.processInstance ?? randomBytes(8).toString("hex");
    this.#closeSink = options.closeSink ?? true;
    const interval = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > MAX_TIMER_DELAY_MS) {
      throw new RangeError(`snapshotIntervalMs must be an integer from 1 through ${MAX_TIMER_DELAY_MS}`);
    }
    this.#snapshotTimer = setInterval(() => this.snapshot("interval"), interval);
    this.#snapshotTimer.unref();
  }

  get level(): ObservabilityLevel { return this.#level; }
  setLevel(level: ObservabilityLevel): void { this.#level = level; }

  /** @internal Releases bookkeeping for a correlated operation that is not a runtime run. */
  releaseCorrelation(runId: string): void {
    this.#commitUsageScope(runId);
    this.#runAliases.delete(runId);
  }

  event(
    area: ObservabilityArea,
    name: string,
    fields: ObservabilityFields = {},
    level: Exclude<ObservabilityLevel, "off"> = "info",
    correlation?: ObservabilityCorrelation,
    timestamp = this.#now().toISOString(),
  ): void {
    if (this.#closed || LEVEL_ORDER[level] > LEVEL_ORDER[this.#level]) return;
    try {
      this.#sink.record({
        schemaVersion: 1,
        kind: "event",
        timestamp,
        processInstance: this.#processInstance,
        mode: this.#mode,
        level,
        area,
        name: utf8Prefix(name, 128),
        ...(correlation === undefined ? {} : { correlation: { ...correlation } }),
        fields: safeFields(fields),
      });
    } catch {
      // Observability must never affect runtime behavior.
    }
  }

  observe(envelope: EventEnvelope): void {
    if (this.#closed || this.#level === "off") return;
    const event = envelope.event;
    const session = this.#sessionAlias(envelope.threadId);
    const run = envelope.runId === undefined ? undefined : this.#runAlias(envelope.runId);
    const correlation: ObservabilityCorrelation = { session, ...(run === undefined ? {} : { run }) };
    const timestamp = envelope.timestamp;
    const now = this.#now().getTime();
    const emit = (
      area: ObservabilityArea,
      name: string,
      fields: ObservabilityFields = {},
      level: Exclude<ObservabilityLevel, "off"> = "info",
    ): void => this.event(area, name, fields, level, correlation, timestamp);

    switch (event.type) {
      case "run_started":
        this.#metrics.runsStarted += 1;
        this.#metrics.activeRuns += 1;
        if (envelope.runId !== undefined) this.#runStarted.set(envelope.runId, now);
        emit("runtime", event.type, {
          reasoning_enabled: event.reasoningEffort !== undefined && event.reasoningEffort !== "off",
          ...(event.promptComposition === undefined
            ? {}
            : {
                prompt_bytes: event.promptComposition.bytes,
                prompt_sources: event.promptComposition.sources.length,
                prompt_tools: event.promptComposition.tools.length,
                prompt_skills: event.promptComposition.skills.length,
                prompt_truncated: event.promptComposition.truncated,
              }),
        });
        return;
      case "model_selected":
        emit("provider", event.type, {
          reasoning_enabled: event.reasoningEffort !== undefined && event.reasoningEffort !== "off",
        });
        return;
      case "run_state": emit("runtime", event.type, { phase: event.state }, "debug"); return;
      case "message_appended":
        if (event.message.role === "tool" && event.message.usage !== undefined) {
          const usageKey = `${envelope.runId ?? "<unscoped>"}:${envelope.eventId}`;
          this.#observeUsage(usageKey, event.message.usage, "final");
          this.#commitUsageScope(usageKey);
        }
        emit("session", event.type, {
          ...messageFields(event.message),
          provider_continuation_present: event.providerState !== undefined,
        }, "debug");
        return;
      case "assistant_started": emit("provider", event.type, { step: event.step }, "debug"); return;
      case "provider_response_started": emit("provider", event.type, { step: event.step }); return;
      case "provider_attempt_started":
        this.#metrics.providerAttempts += 1;
        this.#resetUsageScope(envelope.runId ?? "<unscoped>");
        emit("provider", event.type, {
          step: event.step,
          attempt: event.attempt,
          ...(event.api === undefined ? {} : { api: event.api }),
          reasoning_enabled: event.reasoningEffort !== undefined && event.reasoningEffort !== "off",
          tool_count: event.toolNames.length,
        });
        return;
      case "text_started":
      case "text_delta":
      case "reasoning_started":
      case "reasoning_delta":
      case "tool_call_started":
      case "tool_call_delta":
        return;
      case "text_completed": emit("provider", event.type, { part: event.part, bytes: byteLength(event.text) }, "debug"); return;
      case "reasoning_completed":
        emit("provider", event.type, {
          part: event.part,
          visibility: event.visibility,
          redacted: event.redacted === true,
          bytes: byteLength(event.text),
        }, "debug");
        return;
      case "tool_call_completed":
        emit("provider", event.type, {
          index: event.index,
          argument_bytes: byteLength(event.rawArguments),
          parse_failed: event.parseError !== undefined,
        }, "debug");
        return;
      case "assistant_completed":
        if (event.finishReason !== "cancelled" && event.finishReason !== "aborted" && event.finishReason !== "error") {
          this.#markUsageScopeComplete(envelope.runId ?? "<unscoped>");
        }
        emit("provider", event.type, { finish_reason: event.finishReason });
        return;
      case "assistant_response_transformed": {
        const changed = new Set(event.transformations.flatMap((entry) => entry.fields));
        emit("extension", event.type, {
          step: event.step,
          actor_count: event.transformations.length,
          changed_fields: [...changed].sort().join(","),
          original_finish_reason: event.original.finishReason,
          final_finish_reason: event.final.finishReason,
          ...usageFields(event.original.usage, "original_"),
          ...usageFields(event.final.usage, "final_"),
        });
        return;
      }
      case "tool_input_transformed":
        emit("extension", event.type, { index: event.index, actor_count: event.actors.length });
        return;
      case "tool_requested":
        emit("tool", event.type, { index: event.index, input_bytes: jsonByteLength(event.input) }, "debug");
        return;
      case "tool_started":
        this.#metrics.toolsStarted += 1;
        this.#metrics.activeTools += 1;
        this.#toolObservations.set(event.callId, {
          ...(envelope.runId === undefined ? {} : { runId: envelope.runId }),
          active: true,
          startedAt: now,
          updates: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          producedBytes: 0,
          truncated: false,
        });
        emit("tool", event.type, {
          index: event.index,
          recovery_mode: event.recoveryMode,
          input_bytes: jsonByteLength(event.input),
        });
        return;
      case "tool_dispatching":
        emit("tool", event.type, {
          index: event.index,
          recovery_mode: event.recoveryMode,
          step: event.step,
        }, "debug");
        return;
      case "tool_progress": {
        const progress = this.#toolObservations.get(event.callId) ?? {
          ...(envelope.runId === undefined ? {} : { runId: envelope.runId }),
          active: false,
          updates: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          producedBytes: 0,
          truncated: false,
        };
        progress.updates += 1;
        if (event.progress.type === "output") {
          progress.stdoutBytes = Math.max(progress.stdoutBytes, event.progress.stdoutBytes);
          progress.stderrBytes = Math.max(progress.stderrBytes, event.progress.stderrBytes);
        } else progress.producedBytes = Math.max(progress.producedBytes, byteLength(event.progress.content));
        progress.truncated ||= event.progress.truncated === true;
        this.#toolObservations.set(event.callId, progress);
        return;
      }
      case "tool_completed": {
        const progress = this.#toolObservations.get(event.callId);
        this.#toolObservations.delete(event.callId);
        this.#metrics.toolsCompleted += 1;
        if (progress?.active === true) this.#metrics.activeTools = Math.max(0, this.#metrics.activeTools - 1);
        if (event.isError) this.#metrics.toolsFailed += 1;
        emit("tool", event.type, {
          index: event.index,
          failed: event.isError,
          updates: progress?.updates ?? 0,
          stdout_bytes: progress?.stdoutBytes ?? 0,
          stderr_bytes: progress?.stderrBytes ?? 0,
          produced_bytes: progress?.producedBytes ?? 0,
          truncated: progress?.truncated ?? false,
          ...(progress?.startedAt === undefined ? {} : { duration_ms: Math.max(0, now - progress.startedAt) }),
        }, event.isError ? "error" : "info");
        return;
      }
      case "tool_in_doubt":
        this.#metrics.toolsInDoubt += 1;
        emit("tool", event.type, { index: event.index }, "error");
        return;
      case "usage":
        this.#observeUsage(envelope.runId, event.usage, event.semantics);
        emit("provider", event.type, { semantics: event.semantics, ...usageFields(event.usage) }, "debug");
        return;
      case "retry_scheduled":
        this.#metrics.providerRetries += 1;
        emit("provider", event.type, {
          attempt: event.attempt,
          delay_ms: event.delayMs,
          category: failureCategory(event.category),
          ...(event.maxAttempts === undefined ? {} : { max_attempts: event.maxAttempts }),
          ...(event.phase === undefined ? {} : { phase: event.phase }),
        });
        return;
      case "retry_attempt_started":
        emit("provider", event.type, { attempt: event.attempt, step: event.step });
        return;
      case "summarization_retry_scheduled":
        emit("runtime", event.type, { attempt: event.attempt, max_attempts: event.maxAttempts, delay_ms: event.delayMs });
        return;
      case "summarization_retry_attempt_start":
        this.#resetUsageScope(envelope.runId ?? "<unscoped>");
        emit("runtime", event.type, {
          source: event.source,
          ...(event.source === "compaction" ? { compaction_reason: event.reason } : {}),
        });
        return;
      case "summarization_retry_finished": emit("runtime", event.type); return;
      case "compaction_started":
        this.#metrics.compactionsStarted += 1;
        this.#compactionStarted.set(envelope.threadId, now);
        this.#resetUsageScope(envelope.runId ?? "<unscoped>");
        emit("session", event.type, {
          ...(event.reason === undefined ? {} : { compaction_reason: event.reason }),
          ...(event.willRetry === undefined ? {} : { will_retry: event.willRetry }),
          ...(event.estimatedTokensBefore === undefined
            ? {}
            : { estimated_tokens_before: event.estimatedTokensBefore }),
        });
        return;
      case "compaction_completed": {
        this.#metrics.compactionsCompleted += 1;
        if (event.fromExtension && event.usage !== undefined) {
          this.#observeUsage(envelope.runId, event.usage, "final");
        }
        if (!event.fromExtension || event.usage !== undefined) {
          this.#markUsageScopeComplete(envelope.runId ?? "<unscoped>");
        }
        const started = this.#compactionStarted.get(envelope.threadId);
        this.#compactionStarted.delete(envelope.threadId);
        emit("session", event.type, {
          source_message_count: event.sourceMessageIds.length,
          tokens_before: event.tokensBefore,
          ...(event.estimatedTokensAfter === undefined ? {} : { estimated_tokens_after: event.estimatedTokensAfter }),
          ...(event.reason === undefined ? {} : { compaction_reason: event.reason }),
          ...(event.willRetry === undefined ? {} : { will_retry: event.willRetry }),
          from_extension: event.fromExtension,
          ...(started === undefined ? {} : { duration_ms: Math.max(0, now - started) }),
          ...usageFields(event.usage),
        });
        return;
      }
      case "compaction_failed": {
        this.#metrics.compactionsFailed += 1;
        const started = this.#compactionStarted.get(envelope.threadId);
        this.#compactionStarted.delete(envelope.threadId);
        emit("session", event.type, {
          compaction_reason: event.reason,
          aborted: event.aborted,
          will_retry: event.willRetry,
          ...(event.category === undefined ? {} : { category: failureCategory(event.category) }),
          ...(started === undefined ? {} : { duration_ms: Math.max(0, now - started) }),
        }, "error");
        return;
      }
      case "branch_summary_created":
        this.#metrics.branchSummaries += 1;
        if (event.usage !== undefined) this.#observeUsage(envelope.runId, event.usage, "final");
        emit("session", event.type, { source_event_count: event.sourceEventIds.length, ...usageFields(event.usage) });
        return;
      case "entry_label_changed": emit("session", event.type, { has_label: event.label !== undefined }, "debug"); return;
      case "steering_queued": emit("session", event.type); return;
      case "run_completed":
        this.#metrics.runsCompleted += 1;
        this.#metrics.activeRuns = Math.max(0, this.#metrics.activeRuns - 1);
        emit("runtime", event.type, {
          finish_reason: event.finishReason,
          ...this.#runDuration(envelope.runId, now),
        });
        this.#releaseRun(envelope.runId);
        return;
      case "run_failed":
        this.#metrics.runsFailed += 1;
        this.#metrics.activeRuns = Math.max(0, this.#metrics.activeRuns - 1);
        emit("runtime", event.type, { ...runFailureFields(event), ...this.#runDuration(envelope.runId, now) }, "error");
        this.#releaseRun(envelope.runId);
        return;
      case "run_cancelled":
        this.#metrics.runsCancelled += 1;
        this.#metrics.activeRuns = Math.max(0, this.#metrics.activeRuns - 1);
        emit("runtime", event.type, this.#runDuration(envelope.runId, now));
        this.#releaseRun(envelope.runId);
        return;
      case "warning":
        this.#metrics.warnings += 1;
        emit("runtime", event.type, { code: warningCode(event.code), has_details: event.details !== undefined });
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  snapshot(reason: "interval" | "shutdown" | "manual" = "manual"): void {
    if (this.#closed || LEVEL_ORDER[this.#level] < LEVEL_ORDER.info) return;
    const metrics = this.#metrics;
    const activeUsageScopes = [...this.#usageTelemetryScopes.values()].filter((scope) =>
      scope.hasUsage || scope.completed);
    const usageScopes = metrics.usageTelemetryScopes + activeUsageScopes.length;
    const complete = (metricComplete: boolean, select: (scope: UsageTelemetryScope) => boolean): boolean =>
      usageScopes > 0 && metricComplete && activeUsageScopes.every(select);
    const inputTokensComplete = complete(metrics.inputTokensComplete, (scope) => scope.inputComplete);
    const outputTokensComplete = complete(metrics.outputTokensComplete, (scope) => scope.outputComplete);
    const totalTokensComplete = complete(metrics.totalTokensComplete, (scope) => scope.totalComplete);
    const cacheReadTokensComplete = complete(metrics.cacheReadTokensComplete, (scope) => scope.readComplete);
    const cacheWriteTokensComplete = complete(metrics.cacheWriteTokensComplete, (scope) => scope.writeComplete);
    const costComplete = complete(metrics.costComplete, (scope) => scope.costComplete);
    try {
      this.#sink.record({
        schemaVersion: 1,
        kind: "metrics_snapshot",
        timestamp: this.#now().toISOString(),
        processInstance: this.#processInstance,
        mode: this.#mode,
        level: "info",
        area: "runtime",
        name: "metrics_snapshot",
        fields: safeFields({
        reason,
        runs_started: metrics.runsStarted,
        runs_completed: metrics.runsCompleted,
        runs_failed: metrics.runsFailed,
        runs_cancelled: metrics.runsCancelled,
        provider_attempts: metrics.providerAttempts,
        provider_retries: metrics.providerRetries,
        tools_started: metrics.toolsStarted,
        tools_completed: metrics.toolsCompleted,
        tools_failed: metrics.toolsFailed,
        tools_in_doubt: metrics.toolsInDoubt,
        compactions_started: metrics.compactionsStarted,
        compactions_completed: metrics.compactionsCompleted,
        compactions_failed: metrics.compactionsFailed,
        branch_summaries: metrics.branchSummaries,
        warnings: metrics.warnings,
        active_runs: metrics.activeRuns,
        active_tools: metrics.activeTools,
        usage_scopes: usageScopes,
        ...(inputTokensComplete
          ? { input_tokens: metrics.inputTokens }
          : metrics.inputTokensObserved
            ? { input_tokens_reported: metrics.inputTokens }
            : {}),
        ...(outputTokensComplete
          ? { output_tokens: metrics.outputTokens }
          : metrics.outputTokensObserved
            ? { output_tokens_reported: metrics.outputTokens }
            : {}),
        ...(totalTokensComplete
          ? { total_tokens: metrics.totalTokens }
          : metrics.totalTokensObserved
            ? { total_tokens_reported: metrics.totalTokens }
            : {}),
        ...(cacheReadTokensComplete
          ? { cache_read_tokens: metrics.cacheReadTokens }
          : metrics.cacheReadTokensObserved
            ? { cache_read_tokens_reported: metrics.cacheReadTokens }
            : {}),
        ...(cacheWriteTokensComplete
          ? { cache_write_tokens: metrics.cacheWriteTokens }
          : metrics.cacheWriteTokensObserved
            ? { cache_write_tokens_reported: metrics.cacheWriteTokens }
            : {}),
        cache_write_1h_tokens: metrics.cacheWrite1hTokens,
        reasoning_tokens: metrics.reasoningTokens,
        server_tool_calls: metrics.serverToolCalls,
        provider_duration_ms: metrics.durationMs,
        ...(costComplete
          ? {
              cost_input: metrics.costInput,
              cost_output: metrics.costOutput,
              cost_cache_read: metrics.costCacheRead,
              cost_cache_write: metrics.costCacheWrite,
              cost_total: metrics.costTotal,
            }
          : metrics.costObserved
            ? {
                cost_input_reported: metrics.costInput,
                cost_output_reported: metrics.costOutput,
                cost_cache_read_reported: metrics.costCacheRead,
                cost_cache_write_reported: metrics.costCacheWrite,
                cost_total_reported: metrics.costTotal,
              }
            : {}),
        input_tokens_observed: metrics.inputTokensObserved,
        input_tokens_complete: inputTokensComplete,
        output_tokens_observed: metrics.outputTokensObserved,
        output_tokens_complete: outputTokensComplete,
        total_tokens_observed: metrics.totalTokensObserved,
        total_tokens_complete: totalTokensComplete,
        cache_telemetry_observed: metrics.cacheTelemetryObserved,
        cache_read_tokens_observed: metrics.cacheReadTokensObserved,
        cache_write_tokens_observed: metrics.cacheWriteTokensObserved,
        cache_read_tokens_complete: cacheReadTokensComplete,
        cache_write_tokens_complete: cacheWriteTokensComplete,
        cost_observed: metrics.costObserved,
        cost_complete: costComplete,
        provider_duration_observed: metrics.providerDurationObserved,
        }),
      });
    } catch {
      // Observability must never affect runtime behavior.
    }
  }

  async flush(): Promise<void> {
    try { await this.#sink.flush(); }
    catch { /* Observability must never affect runtime behavior. */ }
  }

  close(): Promise<void> {
    this.#closeFlight ??= this.#closeOnce();
    return this.#closeFlight;
  }

  async #closeOnce(): Promise<void> {
    if (this.#closed) return;
    this.snapshot("shutdown");
    this.#closed = true;
    clearInterval(this.#snapshotTimer);
    this.#sessionAliases.clear();
    this.#runAliases.clear();
    this.#runStarted.clear();
    this.#toolObservations.clear();
    this.#compactionStarted.clear();
    this.#accountedUsage.clear();
    this.#usageTelemetryScopes.clear();
    try {
      if (this.#closeSink) await this.#sink.close();
      else await this.#sink.flush();
    } catch {
      // Observability must never affect runtime behavior.
    }
  }

  #sessionAlias(threadId: string): string {
    const existing = this.#sessionAliases.get(threadId);
    if (existing !== undefined) {
      this.#sessionAliases.delete(threadId);
      this.#sessionAliases.set(threadId, existing);
      return existing;
    }
    if (this.#sessionAliases.size >= MAX_SESSION_ALIASES) {
      const oldest = this.#sessionAliases.keys().next().value;
      if (oldest !== undefined) this.#sessionAliases.delete(oldest);
    }
    const alias = `s${++this.#sessionOrdinal}`;
    this.#sessionAliases.set(threadId, alias);
    return alias;
  }

  #runAlias(runId: string): string {
    const existing = this.#runAliases.get(runId);
    if (existing !== undefined) return existing;
    const alias = `r${++this.#runOrdinal}`;
    this.#runAliases.set(runId, alias);
    return alias;
  }

  #runDuration(runId: string | undefined, now: number): ObservabilityFields {
    if (runId === undefined) return {};
    const started = this.#runStarted.get(runId);
    return started === undefined ? {} : { duration_ms: Math.max(0, now - started) };
  }

  #releaseRun(runId: string | undefined): void {
    if (runId === undefined) return;
    let abandonedTools = 0;
    for (const [callId, observation] of this.#toolObservations) {
      if (observation.runId !== runId) continue;
      this.#toolObservations.delete(callId);
      if (observation.active) abandonedTools += 1;
    }
    this.#metrics.activeTools = Math.max(0, this.#metrics.activeTools - abandonedTools);
    this.#runStarted.delete(runId);
    this.#commitUsageScope(runId);
    this.#runAliases.delete(runId);
  }

  #commitUsageScope(key: string): void {
    const scope = this.#usageTelemetryScopes.get(key);
    if (scope !== undefined && (scope.hasUsage || scope.completed)) {
      this.#metrics.usageTelemetryScopes += 1;
      this.#metrics.inputTokensComplete &&= scope.inputComplete;
      this.#metrics.outputTokensComplete &&= scope.outputComplete;
      this.#metrics.totalTokensComplete &&= scope.totalComplete;
      this.#metrics.cacheReadTokensComplete &&= scope.readComplete;
      this.#metrics.cacheWriteTokensComplete &&= scope.writeComplete;
      this.#metrics.costComplete &&= scope.costComplete;
    }
    this.#usageTelemetryScopes.delete(key);
    this.#accountedUsage.delete(key);
  }

  #resetUsageScope(key: string): void {
    this.#commitUsageScope(key);
    this.#accountedUsage.set(key, emptyUsage());
    this.#usageTelemetryScopes.set(key, emptyUsageTelemetryScope());
  }

  #markUsageScopeComplete(key: string): void {
    const scope = this.#usageTelemetryScopes.get(key) ?? emptyUsageTelemetryScope();
    scope.completed = true;
    this.#usageTelemetryScopes.set(key, scope);
  }

  #observeUsage(runId: string | undefined, usage: NormalizedUsage, semantics: "incremental" | "cumulative" | "final"): void {
    this.#metrics.inputTokensObserved ||= usage.inputTokens !== undefined;
    this.#metrics.outputTokensObserved ||= usage.outputTokens !== undefined;
    this.#metrics.totalTokensObserved ||= usage.totalTokens !== undefined;
    this.#metrics.cacheTelemetryObserved ||=
      usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined;
    this.#metrics.cacheReadTokensObserved ||= usage.cacheReadTokens !== undefined;
    this.#metrics.cacheWriteTokensObserved ||= usage.cacheWriteTokens !== undefined;
    this.#metrics.costObserved ||= usage.cost !== undefined;
    this.#metrics.providerDurationObserved ||= usage.durationMs !== undefined;
    const key = runId ?? "<unscoped>";
    const accounted = this.#accountedUsage.get(key) ?? emptyUsage();
    const scope = this.#usageTelemetryScopes.get(key) ?? emptyUsageTelemetryScope();
    const next = numericUsage(usage);
    const incremental = semantics === "incremental";
    const incrementalContinuation = incremental && scope.hasUsage;
    for (const [field, completeField, overflowField] of COMPLETE_USAGE_FIELDS) {
      const reported = usage[field] !== undefined;
      const reconciled = reconcileUsageInteger(this.#metrics, accounted, field, next[field], incremental);
      if (incremental) {
        if (!reconciled) scope[overflowField] = true;
        const available = incrementalContinuation ? scope[completeField] || reported : reported;
        scope[completeField] = available && !scope[overflowField];
      } else {
        scope[overflowField] = !reconciled;
        scope[completeField] = reported && reconciled;
      }
    }
    for (const field of AUXILIARY_USAGE_FIELDS) {
      reconcileUsageInteger(this.#metrics, accounted, field, next[field], incremental);
    }
    const costReported = usage.cost !== undefined;
    const costReconciled = reconcileUsageCost(this.#metrics, accounted, next, incremental);
    if (incremental) {
      if (!costReconciled) scope.costOverflowed = true;
      const available = incrementalContinuation ? scope.costComplete && costReported : costReported;
      scope.costComplete = available && !scope.costOverflowed;
    } else {
      scope.costOverflowed = !costReconciled;
      scope.costComplete = costReported && costReconciled;
    }
    scope.hasUsage = true;
    this.#accountedUsage.set(key, accounted);
    this.#usageTelemetryScopes.set(key, scope);
  }
}
