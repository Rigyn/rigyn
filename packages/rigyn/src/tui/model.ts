import type { EventEnvelope, RuntimeEvent } from "../core/events.js";
import type { JsonValue } from "../core/json.js";
import type { CanonicalMessage, NormalizedUsage } from "../core/types.js";
import type { CustomMessageEntry } from "../extensions/session-contract.js";
import { addNormalizedUsage, normalizedContextTokens } from "../core/usage.js";
import type { TranscriptImage } from "./terminal-image.js";
import type {
  TranscriptEntry,
  TuiContext,
  TuiLimits,
  TuiSessionEntry,
  TuiTranscriptItem,
  TuiUsageSummary,
} from "./types.js";
import { byteTail, byteTruncate, sanitizeTerminalText } from "./unicode.js";

function messageText(message: CanonicalMessage, imageMarkers = true): string {
  if (message.displayText !== undefined) return message.displayText;
  return message.content.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "image") return imageMarkers ? [`[Image: ${block.mediaType}]`] : [];
    if (block.type === "tool_result") return [block.content];
    return [];
  }).join("\n");
}

function directMessageImages(message: CanonicalMessage): TranscriptImage[] {
  let index = 0;
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];
    const selected = { key: `${message.id}:image:${index}`, block };
    index += 1;
    return [selected];
  });
}

function toolResultImages(callId: string, images: readonly import("../core/types.js").ImageBlock[] | undefined): TranscriptImage[] {
  return (images ?? []).map((block, index) => ({ key: `tool:${callId}:image:${index}`, block }));
}

function customMessageText(entry: CustomMessageEntry): string {
  if (typeof entry.content === "string") return entry.content;
  return entry.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function customMessageImages(entry: CustomMessageEntry): TranscriptImage[] {
  if (typeof entry.content === "string") return [];
  return entry.content.flatMap((block, index) => block.type === "image"
    ? [{ key: `${entry.id}:image:${index}`, block: { type: "image", mediaType: block.mimeType, data: block.data } }]
    : []);
}

function errorMessage(event: Extract<RuntimeEvent, { type: "run_failed" }>): string {
  return event.error.message;
}

function eventKey(envelope: EventEnvelope, suffix: string): string {
  return `${envelope.runId ?? envelope.threadId}:${suffix}`;
}

const mutationTools = new Set(["write", "edit", "apply_patch"]);
const shellTools = new Set(["shell", "bash"]);
const USER_SHELL_MESSAGE_PREFIX = "[User shell command]\n";

function boundedToolPreview(value: string, maximumBytes: number): string {
  const safe = sanitizeTerminalText(value);
  if (Buffer.byteLength(safe, "utf8") <= maximumBytes) return safe;
  const marker = "\n… truncated";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return markerBytes < maximumBytes
    ? `${byteTruncate(safe, maximumBytes - markerBytes)}${marker}`
    : byteTruncate(safe, maximumBytes);
}

function boundedToolTailPreview(value: string, maximumBytes: number): string {
  const safe = sanitizeTerminalText(value);
  if (Buffer.byteLength(safe, "utf8") <= maximumBytes) return safe;
  const marker = "… earlier output truncated\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return markerBytes < maximumBytes
    ? `${marker}${byteTail(safe, maximumBytes - markerBytes)}`
    : byteTail(safe, maximumBytes);
}

function boundedJsonView(value: JsonValue, maximumBytes: number): JsonValue | undefined {
  let nodes = 0;
  const sanitize = (selected: JsonValue, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > 4_096 || depth > 32) throw new Error("Tool renderer data is too deeply nested");
    if (typeof selected === "string") return sanitizeTerminalText(selected);
    if (selected === null || typeof selected !== "object") return selected;
    if (Array.isArray(selected)) return selected.map((entry) => sanitize(entry, depth + 1));
    return Object.fromEntries(Object.entries(selected).map(([key, entry]) => [
      sanitizeTerminalText(key),
      sanitize(entry, depth + 1),
    ]));
  };
  try {
    const safe = sanitize(value, 0);
    return Buffer.byteLength(JSON.stringify(safe), "utf8") <= maximumBytes ? safe : undefined;
  } catch {
    return undefined;
  }
}

function boundedToolResult(
  content: string,
  isError: boolean,
  metadata: JsonValue | undefined,
  maximumBytes: number,
  tail = false,
): NonNullable<NonNullable<TranscriptEntry["toolData"]>["result"]> {
  const safeMetadata = metadata === undefined ? undefined : boundedJsonView(metadata, maximumBytes);
  return {
    content: tail ? boundedToolTailPreview(content, maximumBytes) : boundedToolPreview(content, maximumBytes),
    isError,
    ...(safeMetadata === undefined ? {} : { metadata: safeMetadata }),
  };
}

interface UserShellProjection {
  command: string;
  output: string;
  isError: boolean;
  metadata?: JsonValue;
}

function userShellProjection(value: string): UserShellProjection | undefined {
  if (!value.startsWith(USER_SHELL_MESSAGE_PREFIX)) return undefined;
  const payload = value.slice(USER_SHELL_MESSAGE_PREFIX.length);
  const separator = payload.indexOf("\n");
  const commandLine = separator < 0 ? payload : payload.slice(0, separator);
  if (!commandLine.startsWith("$ ") || commandLine.length <= 2) return undefined;

  const lines = (separator < 0 ? "" : payload.slice(separator + 1)).split("\n");
  let exitCode: number | undefined;
  let signal: string | undefined;
  const terminalStatus = lines.at(-1) ?? "";
  const exit = /^exit (-?\d+|unknown)$/u.exec(terminalStatus);
  if (exit !== null) {
    lines.pop();
    if (exit[1] !== "unknown") exitCode = Number.parseInt(exit[1]!, 10);
  } else if (terminalStatus.startsWith("signal ") && terminalStatus.length > 7) {
    lines.pop();
    signal = terminalStatus.slice(7);
  }

  let truncated = false;
  if (lines.at(-1) === "… output truncated") {
    lines.pop();
    truncated = true;
  }
  const metadata: Record<string, JsonValue> = {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(truncated ? { truncated: true } : {}),
  };
  return {
    command: commandLine.slice(2),
    output: lines.join("\n"),
    isError: signal !== undefined || (exitCode !== undefined && exitCode !== 0),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

function inputText(input: JsonValue, key: string): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function prefixedLines(value: string, prefix: "+ " | "- "): string[] {
  return sanitizeTerminalText(value).split("\n").map((line) => `${prefix}${line}`);
}

function mutationInputPreview(name: string, input: JsonValue, maximumBytes: number): string | undefined {
  let preview: string | undefined;
  if (name === "write") {
    const content = inputText(input, "content");
    if (content !== undefined) preview = prefixedLines(content, "+ ").join("\n");
  } else if (name === "edit") {
    const oldText = inputText(input, "oldText");
    const newText = inputText(input, "newText");
    if (oldText !== undefined && newText !== undefined) {
      preview = ["--- old", ...prefixedLines(oldText, "- "), "+++ new", ...prefixedLines(newText, "+ ")].join("\n");
    } else if (input !== null && typeof input === "object" && !Array.isArray(input) && Array.isArray(input.edits)) {
      const sections: string[] = [];
      for (const [index, selected] of input.edits.slice(0, 32).entries()) {
        if (selected === null || typeof selected !== "object" || Array.isArray(selected)) continue;
        const before = typeof selected.oldText === "string" ? selected.oldText : undefined;
        const after = typeof selected.newText === "string" ? selected.newText : undefined;
        if (before === undefined || after === undefined) continue;
        sections.push(
          `--- edit ${index + 1} before`,
          ...prefixedLines(before, "- "),
          `+++ edit ${index + 1} after`,
          ...prefixedLines(after, "+ "),
        );
      }
      const omitted = input.edits.length - 32;
      if (omitted > 0) sections.push(`… ${omitted} additional ${omitted === 1 ? "edit" : "edits"} not shown`);
      if (sections.length > 0) preview = sections.join("\n");
    }
  } else if (name === "apply_patch") preview = inputText(input, "patch") ?? inputText(input, "patchText");
  return preview === undefined ? undefined : boundedToolPreview(preview, maximumBytes);
}

function mutationResultPreview(
  name: string,
  isError: boolean,
  metadata: JsonValue | undefined,
  maximumBytes: number,
): string | undefined {
  if (isError || !mutationTools.has(name) || metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const patch = [metadata.diff, metadata.patch]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "");
  return patch === undefined ? undefined : boundedToolPreview(patch, maximumBytes);
}

function toolResultPreview(name: string, isError: boolean, value: string, maximumBytes: number): string {
  if (!isError && mutationTools.has(name)) return "";
  return shellTools.has(name)
    ? boundedToolTailPreview(value, maximumBytes)
    : boundedToolPreview(value, maximumBytes);
}

type LiveToolProgress = NonNullable<NonNullable<TranscriptEntry["toolData"]>["progress"]>;

function elapsedText(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

function runPhase(status: NonNullable<TuiContext["status"]>): string {
  if (status === "preparing") return "Preparing request";
  if (status === "streaming") return "Generating response";
  if (status === "tool_planning") return "Planning tools";
  if (status === "executing") return "Running tools";
  return "Working";
}

function liveToolProgressText(progress: LiveToolProgress): string {
  const sections = [
    progress.elapsedMs === undefined ? "" : `Still running · ${elapsedText(progress.elapsedMs)}`,
    progress.stdout === "" ? "" : `stdout (${progress.stdoutBytes} bytes):\n${progress.stdout}`,
    progress.stderr === "" ? "" : `stderr (${progress.stderrBytes} bytes):\n${progress.stderr}`,
  ].filter(Boolean);
  if (progress.truncated) sections.push("… live output truncated");
  return sections.join("\n\n");
}

function toolCallSummary(input: JsonValue, maximumBytes: number): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const candidate = input[key];
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    }
    return undefined;
  };
  const command = value(["command", "cmd"]);
  const url = value(["url", "uri"]);
  const path = value(["path", "filePath", "file", "directory"]);
  const query = value(["query", "pattern"]);
  const summary = command ?? url ?? (query === undefined ? path : path === undefined ? query : `${query} in ${path}`);
  if (summary === undefined) return undefined;
  return byteTruncate(sanitizeTerminalText(summary).replaceAll("\n", " "), maximumBytes);
}

function transcriptEntryBytes(entry: TranscriptEntry): number {
  const extension = entry.extension === undefined
    ? ""
    : `${entry.extension.type}\0${entry.extension.customType}`;
  return Buffer.byteLength(
    `${entry.title ?? ""}${entry.summary ?? ""}${entry.inputPreview ?? ""}${entry.text}${entry.toolData === undefined ? "" : JSON.stringify(entry.toolData)}${extension}`,
    "utf8",
  ) + (entry.images ?? []).reduce(
    (total, image) => total + 64 + Buffer.byteLength(image.block.mediaType, "utf8"),
    0,
  );
}

export class TuiModel {
  readonly #limits: TuiLimits;
  readonly #messageIds = new Set<string>();
  readonly #mutableEntryIds = new Set<string>();
  readonly #usageByRun = new Map<string, NormalizedUsage>();
  readonly #cacheRunContext = new Map<string, { provider: string; model: string; timestamp: number }>();
  readonly #entryBytes = new WeakMap<TranscriptEntry, number>();
  #startup: TranscriptEntry | undefined;
  #entries: TranscriptEntry[] = [];
  #transcriptBytes = 0;
  #context: TuiContext = { active: false, status: "idle" };
  #usage: TuiUsageSummary | undefined;
  #notice: string | undefined;
  #truncated = false;
  #localSequence = 0;
  #assistantStep = 0;
  #reasoningExpanded = false;
  #toolOutputExpanded = true;
  #showCacheMissNotices = false;
  #summarizationRetrySource: "branchSummary" | "compaction" | undefined;
  #lastCacheRequest: {
    provider: string;
    model: string;
    promptTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    timestamp: number;
  } | undefined;

  constructor(limits: TuiLimits) {
    this.#limits = limits;
  }

  get entries(): readonly TranscriptEntry[] {
    return this.#startup === undefined ? this.#entries : [this.#startup, ...this.#entries];
  }

  get context(): TuiContext {
    return this.#context;
  }

  get usage(): TuiUsageSummary | undefined {
    return this.#usage;
  }

  get notice(): string | undefined {
    return this.#notice;
  }

  get toolOutputExpanded(): boolean {
    return this.#toolOutputExpanded;
  }

  setShowCacheMissNotices(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("showCacheMissNotices must be boolean");
    this.#showCacheMissNotices = enabled;
  }

  setContext(value: TuiContext): void {
    const modelChanged = (value.provider !== undefined && value.provider !== this.#context.provider)
      || (value.model !== undefined && value.model !== this.#context.model);
    const becameActive = value.active === true && this.#context.active !== true;
    const becameInactive = value.active === false;
    const activity = becameInactive
      ? undefined
      : becameActive && value.activity === undefined
        ? { phase: runPhase(value.status ?? "streaming"), startedAt: Date.now(), cancellable: true }
        : value.activity ?? this.#context.activity;
    this.#context = {
      ...this.#context,
      ...(modelChanged ? { contextTokens: 0 } : {}),
      ...value,
      ...(activity === undefined ? {} : { activity }),
    };
    if (becameInactive) delete this.#context.activity;
  }

  committableEntries(): readonly TranscriptEntry[] {
    const firstMutable = this.#entries.findIndex((entry) => this.#mutableEntryIds.has(entry.id));
    const stable = firstMutable === -1 ? this.#entries : this.#entries.slice(0, firstMutable);
    return this.#startup === undefined ? stable : [this.#startup, ...stable];
  }

  clearModelContext(): void {
    const {
      provider: _provider,
      model: _model,
      contextTokens: _contextTokens,
      contextWindowTokens: _contextWindowTokens,
      thinkingSupported: _thinkingSupported,
      subscription: _subscription,
      ...context
    } = this.#context;
    this.#context = context;
  }

  clearTranscript(): void {
    this.#entries = [];
    this.#transcriptBytes = 0;
    this.#messageIds.clear();
    this.#mutableEntryIds.clear();
    this.#usageByRun.clear();
    this.#cacheRunContext.clear();
    this.#lastCacheRequest = undefined;
    this.#usage = undefined;
    this.#context = { ...this.#context, contextTokens: 0 };
    this.#truncated = false;
    this.#assistantStep = 0;
    this.#notice = undefined;
  }

  addLocal(kind: "status" | "warning" | "error", text: string, title?: string): void {
    this.#localSequence += 1;
    this.#append({
      id: `local:${this.#localSequence}`,
      kind,
      text,
      ...(title === undefined ? {} : { title }),
    });
    this.#bound();
  }

  setStartup(compactText: string, expandedText: string): void {
    this.#startup = {
      id: "startup",
      kind: "startup",
      compactText: byteTruncate(sanitizeTerminalText(compactText), 64 * 1024),
      text: byteTruncate(sanitizeTerminalText(expandedText), 128 * 1024),
      expanded: false,
    };
  }

  clearStartup(): void {
    this.#startup = undefined;
  }

  toggleTool(callId?: string): boolean {
    const entries = callId === undefined
      ? [
          ...(this.#startup === undefined ? [] : [this.#startup]),
          ...this.#entries.filter((item) => item.kind === "tool"),
        ]
      : this.#entries.filter((item) => item.callId === callId);
    if (entries.length === 0) return false;
    const expanded = entries.some((entry) => entry.expanded !== true);
    for (const entry of entries) entry.expanded = expanded;
    if (callId === undefined) this.#toolOutputExpanded = expanded;
    return true;
  }

  setToolOutputExpanded(expanded: boolean): boolean {
    if (typeof expanded !== "boolean") throw new TypeError("Tool output expansion must be boolean");
    const changed = this.#toolOutputExpanded !== expanded
      || this.#entries.some((entry) => entry.kind === "tool" && entry.expanded !== expanded);
    this.#toolOutputExpanded = expanded;
    for (const entry of this.#entries) {
      if (entry.kind === "tool") entry.expanded = expanded;
    }
    return changed;
  }

  toggleReasoning(): boolean {
    const entries = this.#entries.filter((entry) => entry.kind === "reasoning");
    if (entries.length === 0) return false;
    this.#reasoningExpanded = !this.#reasoningExpanded;
    for (const entry of entries) entry.expanded = this.#reasoningExpanded;
    return true;
  }

  apply(envelope: EventEnvelope): void {
    this.#apply(envelope);
    this.#bound();
  }

  applySessionEntry(entry: TuiSessionEntry): void {
    if (entry.type === "custom_message" && entry.display !== true) return;
    if (this.#entries.some((candidate) => candidate.id === entry.id)) return;
    const customType = sanitizeTerminalText(entry.customType).replaceAll("\n", " ");
    if (entry.type === "custom") {
      this.#append({
        id: entry.id,
        kind: "status",
        text: "",
        extension: { type: "entry", customType },
      });
    } else {
      const images = customMessageImages(entry);
      this.#append({
        id: entry.id,
        kind: "status",
        text: byteTruncate(sanitizeTerminalText(customMessageText(entry)), Math.min(128 * 1024, this.#limits.maxTranscriptBytes)),
        extension: { type: "message", customType },
        ...(images.length === 0 ? {} : { images }),
      });
    }
    this.#bound();
  }

  applyAll(items: readonly TuiTranscriptItem[]): void {
    for (const item of items) {
      if ("event" in item) this.#apply(item);
      else this.applySessionEntry(item);
      this.#bound();
    }
  }

  #apply(envelope: EventEnvelope): void {
    const event = envelope.event;
    switch (event.type) {
      case "run_started": {
        this.#cacheRunContext.set(envelope.runId ?? `${envelope.threadId}:unscoped`, {
          provider: event.provider,
          model: event.model,
          timestamp: Date.parse(envelope.timestamp),
        });
        const sameModel = this.#context.provider === event.provider && this.#context.model === event.model;
        this.#assistantStep = 0;
        this.#context = {
          ...this.#context,
          provider: event.provider,
          model: event.model,
          ...(sameModel ? {} : { contextTokens: 0 }),
          active: true,
          status: "preparing",
          activity: { phase: "Preparing request", startedAt: Date.now(), cancellable: true },
        };
        this.#notice = undefined;
        break;
      }
      case "model_selected":
        this.#context = { ...this.#context, provider: event.provider, model: event.model };
        break;
      case "run_state":
        this.#context = {
          ...this.#context,
          active: !["completed", "failed", "cancelled"].includes(event.state),
          status: event.state,
          ...(["completed", "failed", "cancelled"].includes(event.state)
            ? {}
            : {
                activity: {
                  phase: runPhase(event.state),
                  startedAt: this.#context.activity?.startedAt ?? Date.now(),
                  cancellable: true,
                },
              }),
        };
        if (["completed", "failed", "cancelled"].includes(event.state)) delete this.#context.activity;
        break;
      case "message_appended":
        this.#appendMessage(event.message);
        break;
      case "assistant_started":
        this.#assistantStep = event.step;
        this.#context = {
          ...this.#context,
          active: true,
          status: "streaming",
          activity: {
            phase: "Generating response",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      case "provider_response_started":
        if (this.#context.model !== undefined && event.model !== this.#context.model) {
          this.#notice = `Provider routed response to ${sanitizeTerminalText(event.model)}`;
        }
        break;
      case "text_delta":
        this.#appendDelta(eventKey(envelope, `text:${this.#assistantStep}`), "assistant", event.text);
        break;
      case "reasoning_delta":
        if (event.visibility === "summary") {
          this.#appendDelta(eventKey(envelope, `reasoning:${this.#assistantStep}:${event.part}`), "reasoning", event.text);
        }
        break;
      case "assistant_completed":
        for (const entry of this.#entries) {
          if (entry.kind === "assistant" || entry.kind === "reasoning") this.#mutableEntryIds.delete(entry.id);
        }
        this.#notice = undefined;
        break;
      case "tool_requested": {
        const assistant = this.#entries.findLast((entry) => entry.kind === "assistant");
        if (assistant !== undefined) assistant.hasToolCalls = true;
        const summary = toolCallSummary(event.input, this.#limits.maxToolPreviewBytes);
        const inputPreview = mutationInputPreview(event.name, event.input, this.#limits.maxToolPreviewBytes);
        const input = boundedJsonView(event.input, this.#limits.maxToolPreviewBytes);
        this.#upsertTool(
          event.callId,
          event.name,
          "pending",
          {
            ...(summary === undefined ? {} : { summary }),
            ...(inputPreview === undefined ? {} : { inputPreview }),
            ...(input === undefined ? {} : { input }),
          },
        );
        this.#mutableEntryIds.add(`tool:${event.callId}`);
        this.#context = {
          ...this.#context,
          status: "tool_planning",
          activity: {
            phase: `Planning ${sanitizeTerminalText(event.name)}`,
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      }
      case "tool_started":
        this.#upsertTool(event.callId, event.name, "running");
        this.#mutableEntryIds.add(`tool:${event.callId}`);
        this.#context = {
          ...this.#context,
          status: "executing",
          activity: {
            phase: `Running ${sanitizeTerminalText(event.name)}`,
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      case "tool_progress":
        this.#updateToolProgress(event.callId, event.name, event.progress);
        this.#mutableEntryIds.add(`tool:${event.callId}`);
        this.#context = { ...this.#context, status: "executing" };
        break;
      case "tool_completed": {
        const completedPreview = mutationResultPreview(
          event.name,
          event.isError,
          event.result?.metadata,
          this.#limits.maxToolPreviewBytes,
        );
        this.#upsertTool(
          event.callId,
          event.name,
          event.isError ? "failed" : "completed",
          {
            text: toolResultPreview(
              event.name,
              event.isError,
              shellTools.has(event.name) ? event.result?.content ?? event.preview : event.preview,
              this.#limits.maxToolPreviewBytes,
            ),
            result: boundedToolResult(
              event.result?.content ?? event.preview,
              event.isError,
              event.result?.metadata,
              this.#limits.maxToolPreviewBytes,
              shellTools.has(event.name),
            ),
            images: toolResultImages(event.callId, event.result?.images),
            ...(completedPreview === undefined ? {} : { inputPreview: completedPreview }),
            clearProgress: true,
          },
        );
        this.#mutableEntryIds.add(`tool:${event.callId}`);
        break;
      }
      case "tool_in_doubt":
        this.#upsertTool(event.callId, event.name, "in_doubt", {
          text: boundedToolPreview(event.reason, this.#limits.maxToolPreviewBytes),
          result: boundedToolResult(event.reason, true, undefined, this.#limits.maxToolPreviewBytes),
          clearProgress: true,
        });
        this.#mutableEntryIds.delete(`tool:${event.callId}`);
        break;
      case "usage":
        {
          const usageKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          const prior = this.#usageByRun.get(usageKey);
          const current = event.semantics === "incremental" ? addNormalizedUsage(prior, event.usage) : { ...event.usage };
          this.#usageByRun.set(usageKey, current);
          const contextTokens = normalizedContextTokens(current);
          if (contextTokens !== undefined) this.#context = { ...this.#context, contextTokens };
          const aggregate = [...this.#usageByRun.values()].reduce<NormalizedUsage>((total, value) => addNormalizedUsage(total, value), {});
          const promptTokens = (current.inputTokens ?? 0) + (current.cacheReadTokens ?? 0) + (current.cacheWriteTokens ?? 0);
          this.#usage = {
            total: aggregate,
            ...(promptTokens === 0
              ? {}
              : { latestCacheHitRate: (current.cacheReadTokens ?? 0) / promptTokens * 100 }),
          };
        }
        break;
      case "retry_scheduled":
        if (event.phase === "compaction") break;
        this.#append({
          id: envelope.eventId,
          kind: "status",
          text: `Retrying ${event.category} in ${event.delayMs} ms (attempt ${event.attempt})`,
        });
        this.#context = {
          ...this.#context,
          active: true,
          activity: {
            phase: `Retrying ${sanitizeTerminalText(event.category)}`,
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            retryAt: Date.now() + event.delayMs,
            attempt: event.attempt,
            cancellable: true,
          },
        };
        break;
      case "summarization_retry_scheduled":
        this.#summarizationRetrySource ??= "branchSummary";
        this.#append({
          id: envelope.eventId,
          kind: "status",
          title: this.#summarizationRetrySource === "compaction" ? "Compaction retry" : "Branch summary retry",
          text: `${event.errorMessage}\nRetrying in ${event.delayMs} ms (attempt ${event.attempt}/${event.maxAttempts})`,
        });
        this.#context = {
          ...this.#context,
          active: true,
          activity: {
            phase: this.#summarizationRetrySource === "compaction" ? "Retrying compaction" : "Retrying branch summary",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            retryAt: Date.now() + event.delayMs,
            attempt: event.attempt,
            cancellable: true,
          },
        };
        break;
      case "summarization_retry_attempt_start":
        this.#summarizationRetrySource = event.source;
        this.#context = {
          ...this.#context,
          active: true,
          activity: {
            phase: event.source === "branchSummary" ? "Summarizing abandoned branch" : "Compacting context",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      case "summarization_retry_finished":
        if (this.#summarizationRetrySource !== "compaction") {
          this.#context = { ...this.#context, active: false };
          delete this.#context.activity;
        }
        this.#summarizationRetrySource = undefined;
        break;
      case "compaction_started":
        this.#summarizationRetrySource = "compaction";
        this.#lastCacheRequest = undefined;
        this.#notice = "Compacting older context";
        this.#context = {
          ...this.#context,
          active: true,
          activity: {
            phase: "Compacting context",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      case "compaction_completed":
        this.#summarizationRetrySource = undefined;
        this.#notice = `Compacted ${event.sourceMessageIds.length} messages`;
        if (this.#context.active === true) this.#context = {
          ...this.#context,
          activity: {
            phase: "Continuing after compaction",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        {
          const { contextTokens: _contextTokens, ...context } = this.#context;
          this.#context = context;
        }
        break;
      case "branch_summary_created":
        this.#lastCacheRequest = undefined;
        this.#append({
          id: envelope.eventId,
          kind: "status",
          title: "Branch summary",
          text: messageText(event.summary),
        });
        break;
      case "entry_label_changed":
        break;
      case "steering_queued":
        this.#notice = "Steering queued for the next model boundary";
        break;
      case "run_completed":
        this.#summarizationRetrySource = undefined;
        this.#recordCacheRequest(envelope);
        this.#mutableEntryIds.clear();
        this.#context = { ...this.#context, active: false, status: "completed" };
        this.#notice = undefined;
        delete this.#context.activity;
        break;
      case "run_failed":
        this.#summarizationRetrySource = undefined;
        this.#cacheRunContext.delete(envelope.runId ?? `${envelope.threadId}:unscoped`);
        this.#mutableEntryIds.clear();
        this.#context = { ...this.#context, active: false, status: "failed" };
        this.#append({ id: envelope.eventId, kind: "error", text: errorMessage(event) });
        delete this.#context.activity;
        break;
      case "run_cancelled":
        this.#summarizationRetrySource = undefined;
        this.#cacheRunContext.delete(envelope.runId ?? `${envelope.threadId}:unscoped`);
        this.#mutableEntryIds.clear();
        this.#context = { ...this.#context, active: false, status: "cancelled" };
        this.#notice = `Cancelled: ${sanitizeTerminalText(event.reason)}`;
        delete this.#context.activity;
        break;
      case "warning":
        // Forward-compatible provider telemetry is retained in the durable event
        // stream for diagnostics, but it is not an actionable user warning. New
        // upstream event types are common and should not interrupt the transcript.
        if (event.code === "unknown_provider_event") break;
        this.#append({ id: envelope.eventId, kind: "warning", title: event.code, text: event.message });
        break;
    }
  }

  #recordCacheRequest(envelope: EventEnvelope): void {
    const key = envelope.runId ?? `${envelope.threadId}:unscoped`;
    const context = this.#cacheRunContext.get(key);
    const usage = this.#usageByRun.get(key);
    this.#cacheRunContext.delete(key);
    if (context === undefined || usage === undefined) return;
    const current = {
      ...context,
      promptTokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    };
    const prior = this.#lastCacheRequest;
    this.#lastCacheRequest = current;
    if (prior === undefined || !this.#showCacheMissNotices) return;
    const cacheAware = prior.cacheReadTokens > 0 || prior.cacheWriteTokens > 0
      || current.cacheReadTokens > 0 || current.cacheWriteTokens > 0;
    if (!cacheAware) return;
    const missedTokens = Math.max(0, Math.min(prior.promptTokens, current.promptTokens) - current.cacheReadTokens);
    if (missedTokens < 20_000) return;
    const modelChanged = prior.provider !== current.provider || prior.model !== current.model;
    const idleMs = Number.isFinite(current.timestamp) && Number.isFinite(prior.timestamp)
      ? current.timestamp - prior.timestamp
      : 0;
    const detail = modelChanged
      ? " after the model changed"
      : idleMs >= 5 * 60_000
        ? " after an idle interval"
        : "";
    this.#append({
      id: `cache-miss:${envelope.eventId}`,
      kind: "warning",
      title: "Cache miss",
      text: `About ${missedTokens.toLocaleString("en-US")} reusable prompt tokens were not read from provider cache${detail}.`,
    });
  }

  #appendMessage(message: CanonicalMessage): void {
    if (message.custom !== undefined) return;
    if (message.role === "tool") {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const completedPreview = mutationResultPreview(
          block.name,
          block.isError,
          block.metadata,
          this.#limits.maxToolPreviewBytes,
        );
        this.#upsertTool(
          block.callId,
          block.name,
          block.isError ? "failed" : "completed",
          {
            text: toolResultPreview(block.name, block.isError, block.content, this.#limits.maxToolPreviewBytes),
            result: boundedToolResult(
              block.content,
              block.isError,
              block.metadata,
              this.#limits.maxToolPreviewBytes,
              shellTools.has(block.name),
            ),
            images: toolResultImages(block.callId, block.images),
            ...(completedPreview === undefined ? {} : { inputPreview: completedPreview }),
            clearProgress: true,
          },
        );
        this.#mutableEntryIds.delete(`tool:${block.callId}`);
      }
      return;
    }
    if (this.#messageIds.has(message.id)) return;
    if (message.role === "system") return;
    const images = directMessageImages(message);
    const text = messageText(message, false);
    const toolCalls = message.role === "assistant"
      ? message.content.filter((block) => block.type === "tool_call")
      : [];
    if (text.trim() === "" && images.length === 0 && toolCalls.length === 0) return;
    this.#messageIds.add(message.id);
    const userShell = message.role === "user" && message.displayText === undefined && images.length === 0
      ? userShellProjection(text)
      : undefined;
    if (userShell !== undefined) {
      const input = boundedJsonView({ command: userShell.command }, this.#limits.maxToolPreviewBytes);
      this.#append({
        id: message.id,
        kind: "tool",
        callId: `user-shell:${message.id}`,
        title: "shell",
        summary: byteTruncate(sanitizeTerminalText(userShell.command).replaceAll("\n", " "), this.#limits.maxToolPreviewBytes),
        text: boundedToolTailPreview(userShell.output, this.#limits.maxToolPreviewBytes),
        toolData: {
          ...(input === undefined ? {} : { input }),
          result: boundedToolResult(
            userShell.output,
            userShell.isError,
            userShell.metadata,
            this.#limits.maxToolPreviewBytes,
            true,
          ),
        },
        status: userShell.isError ? "failed" : "completed",
        expanded: true,
      });
      return;
    }
    if (message.role === "assistant") {
      const live = this.#entries.findLast((entry) => entry.kind === "assistant" && this.#mutableEntryIds.has(entry.id));
      if (live !== undefined) {
        this.#mutableEntryIds.delete(live.id);
        live.id = message.id;
        this.#mutableEntryIds.add(live.id);
        live.text = sanitizeTerminalText(text);
        if (images.length > 0) live.images = images;
        if (toolCalls.length > 0) live.hasToolCalls = true;
        this.#refreshEntryBytes(live);
      } else if (text.trim() !== "" || images.length > 0) {
        this.#append({
          id: message.id,
          kind: "assistant",
          text,
          ...(images.length === 0 ? {} : { images }),
          ...(toolCalls.length === 0 ? {} : { hasToolCalls: true }),
        });
        this.#mutableEntryIds.add(message.id);
      }
      for (const call of toolCalls) {
        const summary = toolCallSummary(call.arguments, this.#limits.maxToolPreviewBytes);
        const inputPreview = mutationInputPreview(call.name, call.arguments, this.#limits.maxToolPreviewBytes);
        const input = boundedJsonView(call.arguments, this.#limits.maxToolPreviewBytes);
        this.#upsertTool(call.callId, call.name, "pending", {
          ...(summary === undefined ? {} : { summary }),
          ...(inputPreview === undefined ? {} : { inputPreview }),
          ...(input === undefined ? {} : { input }),
        });
        this.#mutableEntryIds.add(`tool:${call.callId}`);
      }
      return;
    }
    this.#append({
      id: message.id,
      kind: message.role === "user" ? "user" : "tool",
      text,
      ...(images.length === 0 ? {} : { images }),
    });
  }

  #appendDelta(id: string, kind: "assistant" | "reasoning", value: string): void {
    const safe = sanitizeTerminalText(value);
    if (safe === "") return;
    const entry = this.#entries.findLast((item) => item.id === id);
    if (entry === undefined) this.#append({ id, kind, text: safe, ...(kind === "reasoning" ? { expanded: this.#reasoningExpanded } : {}) });
    else entry.text = byteTruncate(`${entry.text}${safe}`, this.#limits.maxTranscriptBytes);
    if (entry !== undefined) this.#refreshEntryBytes(entry);
    this.#mutableEntryIds.add(id);
  }

  #upsertTool(
    callId: string,
    name: string,
    status: "pending" | "running" | "completed" | "failed" | "in_doubt",
    values: {
      text?: string;
      summary?: string;
      inputPreview?: string;
      input?: JsonValue;
      result?: NonNullable<NonNullable<TranscriptEntry["toolData"]>["result"]>;
      progress?: LiveToolProgress;
      partialResult?: NonNullable<NonNullable<TranscriptEntry["toolData"]>["partialResult"]>;
      clearProgress?: boolean;
      images?: readonly TranscriptImage[];
    } = {},
  ): void {
    const expanded = (status === "completed" || status === "failed" || status === "in_doubt")
      && this.#toolOutputExpanded;
    const entry = this.#entries.findLast((item) => item.callId === callId);
    if (entry === undefined) {
      this.#append({
        id: `tool:${callId}`,
        kind: "tool",
        callId,
        title: sanitizeTerminalText(name),
        text: sanitizeTerminalText(values.text ?? ""),
        ...(values.summary === undefined ? {} : { summary: sanitizeTerminalText(values.summary) }),
        ...(values.inputPreview === undefined ? {} : { inputPreview: sanitizeTerminalText(values.inputPreview) }),
        ...(values.input === undefined && values.result === undefined && values.progress === undefined && values.partialResult === undefined
          ? {}
          : { toolData: {
              ...(values.input === undefined ? {} : { input: values.input }),
              ...(values.progress === undefined ? {} : { progress: values.progress }),
              ...(values.partialResult === undefined ? {} : { partialResult: values.partialResult }),
              ...(values.result === undefined ? {} : { result: values.result }),
            } }),
        status,
        expanded,
        ...(values.images === undefined || values.images.length === 0 ? {} : { images: values.images }),
      });
      return;
    }
    entry.title = sanitizeTerminalText(name);
    entry.status = status;
    entry.expanded = expanded;
    if (values.text !== undefined) entry.text = sanitizeTerminalText(values.text);
    if (values.summary !== undefined) entry.summary = sanitizeTerminalText(values.summary);
    if (values.inputPreview !== undefined) entry.inputPreview = sanitizeTerminalText(values.inputPreview);
    if (values.images !== undefined) {
      if (values.images.length === 0) delete entry.images;
      else entry.images = values.images;
    }
    if (
      values.input !== undefined || values.result !== undefined || values.progress !== undefined ||
      values.partialResult !== undefined || values.clearProgress === true
    ) entry.toolData = {
      ...(entry.toolData?.input === undefined ? {} : { input: entry.toolData.input }),
      ...(entry.toolData?.progress === undefined || values.clearProgress === true ? {} : { progress: entry.toolData.progress }),
      ...(entry.toolData?.partialResult === undefined || values.clearProgress === true
        ? {}
        : { partialResult: entry.toolData.partialResult }),
      ...(entry.toolData?.result === undefined ? {} : { result: entry.toolData.result }),
      ...(values.input === undefined ? {} : { input: values.input }),
      ...(values.progress === undefined ? {} : { progress: values.progress }),
      ...(values.partialResult === undefined ? {} : { partialResult: values.partialResult }),
      ...(values.result === undefined ? {} : { result: values.result }),
    };
    this.#refreshEntryBytes(entry);
  }

  #updateToolProgress(
    callId: string,
    name: string,
    update: Extract<RuntimeEvent, { type: "tool_progress" }>["progress"],
  ): void {
    this.#upsertTool(callId, name, "running");
    if (update.type === "result") {
      const partialResult = {
        ...boundedToolResult(update.content, update.isError, update.metadata, this.#limits.maxToolPreviewBytes),
        ...(update.truncated === true ? { truncated: true } : {}),
      };
      this.#upsertTool(callId, name, "running", {
        text: partialResult.content,
        partialResult,
      });
      return;
    }
    const entry = this.#entries.findLast((item) => item.callId === callId);
    const prior = entry?.toolData?.progress ?? {
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
    };
    const safeDelta = sanitizeTerminalText(update.delta);
    const other = update.stream === "stdout" ? prior.stderr : prior.stdout;
    const selected = update.stream === "stdout" ? prior.stdout : prior.stderr;
    const appended = `${selected}${safeDelta}`;
    const bounded = byteTail(appended, this.#limits.maxToolPreviewBytes);
    const remaining = Math.max(0, this.#limits.maxToolPreviewBytes - Buffer.byteLength(bounded, "utf8"));
    const boundedOther = byteTail(other, remaining);
    const progress: LiveToolProgress = {
      stdout: update.stream === "stdout" ? bounded : boundedOther,
      stderr: update.stream === "stderr" ? bounded : boundedOther,
      stdoutBytes: update.stdoutBytes,
      stderrBytes: update.stderrBytes,
      ...(update.elapsedMs === undefined && prior.elapsedMs === undefined
        ? {}
        : { elapsedMs: update.elapsedMs ?? prior.elapsedMs }),
      truncated: prior.truncated || update.truncated === true || bounded !== appended || boundedOther !== other,
    };
    this.#upsertTool(callId, name, "running", { text: liveToolProgressText(progress), progress });
  }

  #append(entry: TranscriptEntry): void {
    const appended = {
      ...entry,
      text: sanitizeTerminalText(entry.text),
      ...(entry.title === undefined ? {} : { title: sanitizeTerminalText(entry.title) }),
      ...(entry.summary === undefined ? {} : { summary: sanitizeTerminalText(entry.summary) }),
      ...(entry.inputPreview === undefined ? {} : { inputPreview: sanitizeTerminalText(entry.inputPreview) }),
    };
    this.#entries.push(appended);
    this.#refreshEntryBytes(appended);
  }

  #refreshEntryBytes(entry: TranscriptEntry): void {
    const previous = this.#entryBytes.get(entry) ?? 0;
    const next = transcriptEntryBytes(entry);
    this.#entryBytes.set(entry, next);
    this.#transcriptBytes += next - previous;
  }

  #bound(): void {
    let removeCount = 0;
    while (
      this.#entries.length - removeCount > this.#limits.maxTranscriptEntries
      || this.#transcriptBytes > this.#limits.maxTranscriptBytes
    ) {
      const removed = this.#entries[removeCount];
      if (removed === undefined) break;
      this.#transcriptBytes -= this.#entryBytes.get(removed) ?? 0;
      removeCount += 1;
    }
    for (const removed of this.#entries.splice(0, removeCount)) {
      this.#messageIds.delete(removed.id);
      this.#mutableEntryIds.delete(removed.id);
      this.#truncated = true;
    }
    if (this.#truncated) this.#notice = "Older transcript entries were discarded from the viewport";
  }
}
