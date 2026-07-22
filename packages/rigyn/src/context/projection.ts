import { createHash } from "node:crypto";
import { HarnessError } from "../core/errors.js";
import type { MessageId } from "../core/ids.js";
import type {
  CanonicalMessage,
  ContentBlock,
  FinishReason,
  ModelProtocolFamily,
  OutboundImagePolicy,
  ProviderId,
  ToolCallBlock,
  ToolResultBlock,
} from "../core/types.js";

export interface ContextGroup {
  kind: "system" | "turn" | "orphan";
  messages: CanonicalMessage[];
  messageIds: MessageId[];
  estimatedTokens: number;
  containsProviderOpaque: boolean;
  pendingToolCallIds: string[];
}

export interface ContextProjection {
  provider: ProviderId;
  messages: CanonicalMessage[];
  groups: ContextGroup[];
  estimatedTokens: number;
  estimateSource: ContextTokenEstimate["source"];
}

export interface ProviderProjectionOptions {
  outboundImages?: OutboundImagePolicy;
  supportsImages?: boolean;
  model?: string;
  api?: ModelProtocolFamily;
  usageBaseline?: ContextUsageBaseline;
  additionalTokens?: number;
}

export interface ContextUsageBaseline {
  provider: ProviderId;
  model: string;
  api?: ModelProtocolFamily;
  inputTokens: number;
  prefixMessageIds: readonly MessageId[];
}

export interface ContextTokenEstimateOptions {
  provider?: ProviderId;
  model?: string;
  api?: ModelProtocolFamily;
  usageBaseline?: ContextUsageBaseline;
  additionalTokens?: number;
}

export interface ContextTokenEstimate {
  tokens: number;
  source: "estimated" | "usage_floor";
}

const MESSAGE_TOKEN_OVERHEAD = 8;
const BLOCK_TOKEN_OVERHEAD = 4;
const IMAGE_TOKEN_ESTIMATE = 2_048;

/**
 * Conservative tokenizer-independent fallback. ASCII is charged at one token per
 * two bytes; non-ASCII at two tokens per three UTF-8 bytes. This intentionally
 * overestimates ordinary prose/code without treating every source byte as a token.
 */
export function estimateTextTokens(value: string): number {
  let asciiBytes = 0;
  let nonAsciiBytes = 0;
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) asciiBytes += 1;
    else nonAsciiBytes += Buffer.byteLength(character, "utf8");
  }
  return Math.ceil(asciiBytes / 2) + Math.ceil(nonAsciiBytes / 1.5);
}

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

export function estimateMessageTokens(message: CanonicalMessage, provider?: ProviderId): number {
  let tokens = MESSAGE_TOKEN_OVERHEAD;
  for (const block of message.content) {
    if (block.type === "provider_opaque" && provider !== undefined && block.provider !== provider) continue;
    tokens += BLOCK_TOKEN_OVERHEAD;
    if (block.type === "text") tokens += estimateTextTokens(block.text);
    else if (block.type === "thinking") tokens += estimateTextTokens(block.thinking);
    else if (block.type === "image") {
      // Pixel dimensions are unavailable in the canonical block. Charge a fixed,
      // intentionally high visual allowance and never tokenize base64/URL secrets.
      tokens += IMAGE_TOKEN_ESTIMATE + estimateTextTokens(block.mediaType);
    } else if (block.type === "tool_call") {
      tokens += estimateTextTokens(block.name);
      tokens += estimateTextTokens(block.rawArguments ?? jsonText(block.arguments));
      tokens += 8;
    } else if (block.type === "tool_result") {
      tokens += estimateTextTokens(block.name) + estimateTextTokens(block.content) + 8;
      for (const image of block.images ?? []) {
        tokens += BLOCK_TOKEN_OVERHEAD + IMAGE_TOKEN_ESTIMATE + estimateTextTokens(image.mediaType);
      }
    } else {
      tokens += estimateTextTokens(block.mediaType);
      tokens += estimateTextTokens(block.serialized ?? jsonText(block.value));
      tokens += 8;
    }
  }
  return tokens;
}

function validUsagePrefix(
  messages: readonly CanonicalMessage[],
  options: ContextTokenEstimateOptions,
): options is ContextTokenEstimateOptions & { usageBaseline: ContextUsageBaseline; provider: ProviderId; model: string } {
  const baseline = options.usageBaseline;
  return (
    baseline !== undefined &&
    options.provider === baseline.provider &&
    options.model === baseline.model &&
    options.api === baseline.api &&
    Number.isSafeInteger(baseline.inputTokens) &&
    baseline.inputTokens >= 0 &&
    baseline.prefixMessageIds.length <= messages.length &&
    baseline.prefixMessageIds.every((id, index) => messages[index]?.id === id)
  );
}

export function estimateContextTokenUsage(
  messages: readonly CanonicalMessage[],
  options: ContextTokenEstimateOptions = {},
): ContextTokenEstimate {
  const additionalTokens = options.additionalTokens ?? 0;
  if (!Number.isSafeInteger(additionalTokens) || additionalTokens < 0) {
    throw new RangeError("additionalTokens must be a non-negative safe integer");
  }
  const estimated = messages.reduce(
    (total, message) => total + estimateMessageTokens(message, options.provider),
    additionalTokens,
  );
  if (!validUsagePrefix(messages, options)) return { tokens: estimated, source: "estimated" };
  const trailing = messages.slice(options.usageBaseline.prefixMessageIds.length).reduce(
    (total, message) => total + estimateMessageTokens(message, options.provider),
    0,
  );
  const observedFloor = options.usageBaseline.inputTokens + trailing + additionalTokens;
  return observedFloor > estimated
    ? { tokens: observedFloor, source: "usage_floor" }
    : { tokens: estimated, source: "estimated" };
}

export function estimateContextTokens(
  messages: readonly CanonicalMessage[],
  options: ContextTokenEstimateOptions = {},
): number {
  return estimateContextTokenUsage(messages, options).tokens;
}

function completeGroup(kind: ContextGroup["kind"], messages: CanonicalMessage[], provider?: ProviderId): ContextGroup {
  const calls = new Map<string, ToolCallBlock>();
  const results = new Map<string, ToolResultBlock>();
  let containsProviderOpaque = false;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "provider_opaque") containsProviderOpaque = true;
      if (block.type === "tool_call") {
        if (calls.has(block.callId)) {
          throw new HarnessError("CONTEXT_TOOL_GROUP", `Duplicate tool call ${block.callId}`);
        }
        calls.set(block.callId, block);
      }
      if (block.type === "tool_result") {
        if (results.has(block.callId)) {
          throw new HarnessError("CONTEXT_TOOL_GROUP", `Duplicate tool result ${block.callId}`);
        }
        results.set(block.callId, block);
      }
    }
  }
  for (const [callId, result] of results) {
    const call = calls.get(callId);
    if (call === undefined) {
      throw new HarnessError("CONTEXT_TOOL_GROUP", `Tool result ${callId} has no call in its turn`);
    }
    if (call.name !== result.name) {
      throw new HarnessError("CONTEXT_TOOL_GROUP", `Tool result ${callId} changed tool name`);
    }
  }
  return {
    kind,
    messages,
    messageIds: messages.map((message) => message.id),
    estimatedTokens: estimateContextTokens(messages, provider === undefined ? {} : { provider }),
    containsProviderOpaque,
    pendingToolCallIds: [...calls.keys()].filter((callId) => !results.has(callId)),
  };
}

export function groupContextMessages(messages: readonly CanonicalMessage[], provider?: ProviderId): ContextGroup[] {
  const groups: ContextGroup[] = [];
  let current: { kind: "turn" | "orphan"; messages: CanonicalMessage[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    groups.push(completeGroup(current.kind, current.messages, provider));
    current = undefined;
  };
  for (const message of messages) {
    if (message.role === "system") {
      flush();
      groups.push(completeGroup("system", [message], provider));
    } else if (message.role === "user") {
      flush();
      current = { kind: "turn", messages: [message] };
    } else {
      current ??= { kind: "orphan", messages: [] };
      current.messages.push(message);
    }
  }
  flush();
  return groups;
}

interface ProjectedEntry {
  source: CanonicalMessage;
  content: ContentBlock[];
  changed: boolean;
}

const NON_REPLAYABLE_ASSISTANT_REASONS: ReadonlySet<FinishReason> = new Set([
  "cancelled",
  "aborted",
  "error",
]);

function isReplayableMessage(message: CanonicalMessage): boolean {
  return message.role !== "assistant" || (
    message.retryTransient !== true &&
    (message.stopReason === undefined || !NON_REPLAYABLE_ASSISTANT_REASONS.has(message.stopReason))
  );
}

interface ToolBlockRef<T extends ToolCallBlock | ToolResultBlock> {
  entryIndex: number;
  blockIndex: number;
  block: T;
  key: string;
}

function blockKey(entryIndex: number, blockIndex: number): string {
  return `${entryIndex}:${blockIndex}`;
}

const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function imagesAllowed(options: ProviderProjectionOptions): boolean {
  if (options.outboundImages !== undefined && options.outboundImages !== "allow" && options.outboundImages !== "block") {
    throw new RangeError("outboundImages must be allow or block");
  }
  return options.outboundImages !== "block" && options.supportsImages !== false;
}

function signatureBoundaryMatches(
  source: CanonicalMessage,
  provider: ProviderId,
  options: ProviderProjectionOptions,
): boolean {
  return source.role === "assistant"
    && source.provider === provider
    && source.model !== undefined
    && source.model === options.model
    && source.api !== undefined
    && source.api === options.api;
}

function projectEntry(
  source: CanonicalMessage,
  provider: ProviderId,
  options: ProviderProjectionOptions,
): ProjectedEntry {
  const content: ContentBlock[] = [];
  let changed = false;
  let previousUserImagePlaceholder = false;
  const allowImages = imagesAllowed(options);
  const sameSignatureBoundary = signatureBoundaryMatches(source, provider, options);
  for (const block of source.content) {
    if (
      block.type === "provider_opaque" && (
        block.provider !== provider ||
        (options.model !== undefined && source.model !== options.model) ||
        (options.api !== undefined && source.api !== options.api)
      )
    ) {
      changed = true;
    } else if (block.type === "text" && block.textSignature !== undefined && !sameSignatureBoundary) {
      const visible = { ...block };
      delete visible.textSignature;
      content.push(visible);
      previousUserImagePlaceholder = visible.text === USER_IMAGE_PLACEHOLDER;
      changed = true;
    } else if (block.type === "thinking" && !sameSignatureBoundary) {
      if (!block.redacted && block.thinking.trim() !== "") content.push({ type: "text", text: block.thinking });
      previousUserImagePlaceholder = false;
      changed = true;
    } else if (block.type === "tool_call" && block.thoughtSignature !== undefined && !sameSignatureBoundary) {
      const call = { ...block };
      delete call.thoughtSignature;
      content.push(call);
      previousUserImagePlaceholder = false;
      changed = true;
    } else if (block.type === "image" && !allowImages && source.role === "user") {
      if (!previousUserImagePlaceholder) content.push({ type: "text", text: USER_IMAGE_PLACEHOLDER });
      previousUserImagePlaceholder = true;
      changed = true;
    } else if (block.type === "tool_result" && !allowImages && (block.images?.length ?? 0) > 0) {
      const withoutImages = { ...block };
      delete withoutImages.images;
      const visible = block.content === TOOL_IMAGE_PLACEHOLDER || block.content.endsWith(`\n${TOOL_IMAGE_PLACEHOLDER}`)
        ? block.content
        : [block.content, TOOL_IMAGE_PLACEHOLDER].filter((entry) => entry !== "").join("\n");
      content.push({
        ...withoutImages,
        content: visible,
      });
      previousUserImagePlaceholder = false;
      changed = true;
    } else {
      content.push(block);
      previousUserImagePlaceholder = block.type === "text" && block.text === USER_IMAGE_PLACEHOLDER;
    }
  }
  return { source, content, changed };
}

function normalizeIdPart(value: string, maximum = 64): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, maximum).replace(/_+$/u, "");
}

function shortStableHash(value: string): string {
  let left = 0xdeadbeef;
  let right = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 2_654_435_761);
    right = Math.imul(right ^ code, 1_597_334_677);
  }
  left = Math.imul(left ^ (left >>> 16), 2_246_822_507) ^ Math.imul(right ^ (right >>> 13), 3_266_489_909);
  right = Math.imul(right ^ (right >>> 16), 2_246_822_507) ^ Math.imul(left ^ (left >>> 13), 3_266_489_909);
  return `${(right >>> 0).toString(36)}${(left >>> 0).toString(36)}`;
}

function normalizeToolCallIdForDestination(
  value: string,
  provider: ProviderId,
  model: string,
  api: ModelProtocolFamily,
  attempt = 0,
): string {
  if (api === "anthropic-messages" || api === "bedrock-converse") {
    return normalizeIdPart(value);
  }
  if (api === "gemini-generate-content") {
    return model.startsWith("claude-") || model.startsWith("gpt-oss-") ? normalizeIdPart(value) : value;
  }
  if (api === "mistral-conversations") {
    const alphanumeric = value.replace(/[^A-Za-z0-9]/gu, "");
    if (attempt === 0 && alphanumeric.length === 9) return alphanumeric;
    return shortStableHash(attempt === 0 ? (alphanumeric || value) : `${alphanumeric || value}:${attempt}`)
      .replace(/[^A-Za-z0-9]/gu, "")
      .slice(0, 9);
  }
  if (api === "openai-responses") {
    if (!value.includes("|") || !new Set(["openai", "openai-codex", "opencode"]).has(provider)) {
      return normalizeIdPart(value);
    }
    const separator = value.indexOf("|");
    const callId = normalizeIdPart(value.slice(0, separator));
    const itemId = value.slice(separator + 1);
    const normalizedItem = `fc_${createHash("sha256").update(itemId).digest("hex").slice(0, 24)}`;
    return `${callId}|${normalizedItem}`;
  }
  if (api === "openai-chat-completions" && value.includes("|")) {
    const separator = value.indexOf("|");
    const callId = normalizeIdPart(value.slice(0, separator), 40);
    const itemId = normalizeIdPart(value.slice(separator + 1), 40);
    const combined = itemId === "" ? callId : `${callId}_${itemId}`;
    if (combined.length <= 40) return combined;
    const suffix = createHash("sha256").update(value).digest("hex").slice(0, 8);
    return `${callId.slice(0, Math.max(1, 39 - suffix.length))}_${suffix}`;
  }
  if (api === "openai-chat-completions" && provider === "openai") return value.slice(0, 40);
  return value;
}

function messageGroups(entries: readonly ProjectedEntry[]): number[][] {
  const groups: number[][] = [];
  let current: number[] | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    groups.push(current);
    current = undefined;
  };
  entries.forEach((entry, index) => {
    if (entry.source.role === "system") {
      flush();
      groups.push([index]);
    } else if (entry.source.role === "user") {
      flush();
      current = [index];
    } else {
      current ??= [];
      current.push(index);
    }
  });
  flush();
  return groups;
}

function repairToolBlocks(
  entries: ProjectedEntry[],
  provider: ProviderId,
  options: ProviderProjectionOptions,
): Map<string, ContentBlock | null> {
  const changes = new Map<string, ContentBlock | null>();

  for (const group of messageGroups(entries)) {
    const calls = new Map<string, ToolBlockRef<ToolCallBlock>>();
    const results = new Map<ToolBlockRef<ToolCallBlock>, ToolBlockRef<ToolResultBlock>>();
    const assignedOwners = new Map<string, string>();

    for (const entryIndex of group) {
      const entry = entries[entryIndex]!;
      entry.content.forEach((block, blockIndex) => {
        if (block.type !== "tool_call") return;
        const key = blockKey(entryIndex, blockIndex);
        if (entry.source.role !== "assistant" || calls.has(block.callId)) {
          changes.set(key, null);
          return;
        }
        calls.set(block.callId, { entryIndex, blockIndex, block, key });
      });
    }

    for (const entryIndex of group) {
      const entry = entries[entryIndex]!;
      entry.content.forEach((block, blockIndex) => {
        if (block.type !== "tool_result") return;
        const key = blockKey(entryIndex, blockIndex);
        const call = calls.get(block.callId);
        if (
          entry.source.role !== "tool" ||
          call === undefined ||
          call.block.name !== block.name ||
          results.has(call)
        ) {
          changes.set(key, null);
          return;
        }
        results.set(call, { entryIndex, blockIndex, block, key });
      });
    }

    for (const call of calls.values()) {
      const result = results.get(call);
      const original = call.block.callId;
      const source = entries[call.entryIndex]!.source;
      const crossesModelBoundary = options.model !== undefined && options.api !== undefined && (
        source.provider !== provider || source.model !== options.model || source.api !== options.api
      );
      let assigned = original;
      if (crossesModelBoundary) {
        let attempt = 0;
        while (true) {
          assigned = normalizeToolCallIdForDestination(original, provider, options.model!, options.api!, attempt);
          const owner = assignedOwners.get(assigned);
          if (owner === undefined || owner === original) break;
          attempt += 1;
        }
      }
      assignedOwners.set(assigned, original);
      if (assigned !== original) {
        changes.set(call.key, { ...call.block, callId: assigned });
        if (result !== undefined) changes.set(result.key, { ...result.block, callId: assigned });
      }
    }
  }
  return changes;
}

interface PendingToolCall {
  call: ToolCallBlock;
  source: CanonicalMessage;
}

function syntheticToolResultId(
  provider: ProviderId,
  pending: PendingToolCall,
  ordinal: number,
  usedIds: ReadonlySet<string>,
): MessageId {
  let attempt = 0;
  while (true) {
    const digest = createHash("sha256")
      .update(`${provider}\0${pending.source.id}\0${pending.call.callId}\0${ordinal}\0${attempt}`)
      .digest("hex");
    const candidate = `msg_tool_result_${digest.slice(0, 32)}`;
    if (!usedIds.has(candidate)) return candidate;
    attempt += 1;
  }
}

function fillMissingToolResults(
  messages: readonly CanonicalMessage[],
  provider: ProviderId,
): CanonicalMessage[] {
  const result: CanonicalMessage[] = [];
  const usedIds = new Set(messages.map((message) => message.id));
  let pending: PendingToolCall[] = [];
  let completed = new Set<string>();
  let syntheticOrdinal = 0;

  const flush = (): void => {
    for (const entry of pending) {
      if (completed.has(entry.call.callId)) continue;
      const id = syntheticToolResultId(provider, entry, syntheticOrdinal, usedIds);
      syntheticOrdinal += 1;
      usedIds.add(id);
      result.push({
        id,
        role: "tool",
        content: [{
          type: "tool_result",
          callId: entry.call.callId,
          name: entry.call.name,
          content: "No result provided",
          isError: true,
        }],
        createdAt: entry.source.createdAt,
      });
    }
    pending = [];
    completed = new Set();
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      flush();
      pending = message.content
        .filter((block): block is ToolCallBlock => block.type === "tool_call")
        .map((call) => ({ call, source: message }));
    } else if (message.role === "user") {
      flush();
    } else if (message.role === "tool") {
      for (const block of message.content) {
        if (block.type === "tool_result") completed.add(block.callId);
      }
    }
    result.push(message);
  }
  flush();
  return result;
}

export function projectMessagesForProvider(
  messages: readonly CanonicalMessage[],
  provider: ProviderId,
  options: ProviderProjectionOptions = {},
): CanonicalMessage[] {
  const entries = messages
    .filter(isReplayableMessage)
    .map((message) => projectEntry(message, provider, options));
  const changes = repairToolBlocks(entries, provider, options);
  const projected: CanonicalMessage[] = [];
  entries.forEach((entry, entryIndex) => {
    let changed = entry.changed;
    const content: ContentBlock[] = [];
    entry.content.forEach((block, blockIndex) => {
      const replacement = changes.get(blockKey(entryIndex, blockIndex));
      if (replacement === null) {
        changed = true;
      } else if (replacement !== undefined) {
        changed = true;
        content.push(replacement);
      } else {
        content.push(block);
      }
    });
    if (content.length === 0 && entry.source.role === "user" && entry.source.content.length > 0) {
      content.push({ type: "text", text: "[Unsupported user content omitted]" });
      changed = true;
    }
    if (content.length === 0) return;
    projected.push(changed ? { ...entry.source, content } : entry.source);
  });
  return fillMissingToolResults(projected, provider);
}

export function buildContextProjection(
  messages: readonly CanonicalMessage[],
  provider: ProviderId,
  options: ProviderProjectionOptions = {},
): ContextProjection {
  const projected = projectMessagesForProvider(messages, provider, options);
  const groups = groupContextMessages(projected, provider);
  const estimate = estimateContextTokenUsage(projected, {
    provider,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.api === undefined ? {} : { api: options.api }),
    ...(options.usageBaseline === undefined ? {} : { usageBaseline: options.usageBaseline }),
    ...(options.additionalTokens === undefined ? {} : { additionalTokens: options.additionalTokens }),
  });
  return {
    provider,
    messages: projected,
    groups,
    estimatedTokens: estimate.tokens,
    estimateSource: estimate.source,
  };
}

function truncateToolContent(content: string, maxBytes: number): string {
  const data = Buffer.from(content, "utf8");
  if (data.byteLength <= maxBytes) return content;
  const omittedLabel = `\n… ${data.byteLength - maxBytes} or more bytes omitted …\n`;
  const labelBytes = Buffer.byteLength(omittedLabel, "utf8");
  const payloadBudget = Math.max(0, maxBytes - labelBytes);
  const headBytes = Math.ceil(payloadBudget / 2);
  const tailBytes = Math.floor(payloadBudget / 2);
  let headEnd = headBytes;
  while (headEnd > 0 && (data[headEnd] ?? 0) >= 0x80 && (data[headEnd] ?? 0) <= 0xbf) headEnd -= 1;
  let tailStart = data.byteLength - tailBytes;
  while (tailStart < data.byteLength && (data[tailStart] ?? 0) >= 0x80 && (data[tailStart] ?? 0) <= 0xbf) {
    tailStart += 1;
  }
  const head = data.subarray(0, headEnd).toString("utf8");
  const tail = tailBytes === 0 ? "" : data.subarray(tailStart).toString("utf8");
  return `${head}${omittedLabel}${tail}`;
}

export function elideOldToolResults(
  messages: readonly CanonicalMessage[],
  options: { retainRecentTurns?: number; maxResultBytes?: number } = {},
): CanonicalMessage[] {
  const groups = groupContextMessages(messages);
  const retainRecentTurns = options.retainRecentTurns ?? 2;
  const maxResultBytes = options.maxResultBytes ?? 4 * 1024;
  if (!Number.isSafeInteger(retainRecentTurns) || retainRecentTurns < 0) {
    throw new RangeError("retainRecentTurns must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 64) {
    throw new RangeError("maxResultBytes must be at least 64");
  }
  const turnGroups = groups.filter((group) => group.kind !== "system");
  const retained = new Set(turnGroups.slice(-retainRecentTurns));
  return groups.flatMap((group) => {
    if (group.kind === "system" || retained.has(group)) return group.messages;
    return group.messages.map((message) => {
      let changed = false;
      const content: ContentBlock[] = message.content.map((block) => {
        if (block.type !== "tool_result") return block;
        const imageMarkers = (block.images ?? []).length === 0 ? [] : [TOOL_IMAGE_PLACEHOLDER];
        const derived = [block.content, ...imageMarkers].filter((entry) => entry !== "").join("\n");
        const truncated = truncateToolContent(derived, maxResultBytes);
        if (truncated === block.content && imageMarkers.length === 0) return block;
        changed = true;
        const { images: _images, ...withoutImages } = block;
        return {
          ...withoutImages,
          content: truncated,
        };
      });
      return changed ? { ...message, content } : message;
    });
  });
}
