import { createHash } from "node:crypto";
import { HarnessError } from "../core/errors.js";
import type { MessageId } from "../core/ids.js";
import type {
  CanonicalMessage,
  ContentBlock,
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
  usageBaseline?: ContextUsageBaseline;
  additionalTokens?: number;
}

export interface ContextUsageBaseline {
  provider: ProviderId;
  model: string;
  inputTokens: number;
  prefixMessageIds: readonly MessageId[];
}

export interface ContextTokenEstimateOptions {
  provider?: ProviderId;
  model?: string;
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

interface ToolBlockRef<T extends ToolCallBlock | ToolResultBlock> {
  entryIndex: number;
  blockIndex: number;
  block: T;
  key: string;
}

function blockKey(entryIndex: number, blockIndex: number): string {
  return `${entryIndex}:${blockIndex}`;
}

function omittedImageText(mediaType: string): string {
  const safeType = mediaType.replace(/[^\x20-\x7e]/gu, "?").slice(0, 64) || "unknown media type";
  return `[Image omitted: ${safeType}]`;
}

function imagesAllowed(options: ProviderProjectionOptions): boolean {
  if (options.outboundImages !== undefined && options.outboundImages !== "allow" && options.outboundImages !== "block") {
    throw new RangeError("outboundImages must be allow or block");
  }
  return options.outboundImages !== "block" && options.supportsImages !== false;
}

function projectEntry(
  source: CanonicalMessage,
  provider: ProviderId,
  options: ProviderProjectionOptions,
): ProjectedEntry {
  const content: ContentBlock[] = [];
  let changed = false;
  const allowImages = imagesAllowed(options);
  for (const block of source.content) {
    if (block.type === "provider_opaque" && block.provider !== provider) {
      changed = true;
    } else if (block.type === "image" && !allowImages) {
      content.push({ type: "text", text: omittedImageText(block.mediaType) });
      changed = true;
    } else if (block.type === "tool_result" && !allowImages && (block.images?.length ?? 0) > 0) {
      const { images, ...withoutImages } = block;
      content.push({
        ...withoutImages,
        content: [block.content, ...(images ?? []).map((image) => omittedImageText(image.mediaType))]
          .filter((entry) => entry !== "")
          .join("\n"),
      });
      changed = true;
    } else {
      content.push(block);
    }
  }
  return { source, content, changed };
}

function targetSafeToolCallId(value: string): boolean {
  // Conservative intersection accepted by the currently supported wire protocols.
  return /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

function replacementToolCallId(
  provider: ProviderId,
  original: string,
  messageId: string,
  blockIndex: number,
  ordinal: number,
  used: ReadonlySet<string>,
): string {
  const attempts = used.size + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const digest = createHash("sha256")
      .update(`${provider}\0${original}\0${messageId}\0${blockIndex}\0${ordinal}\0${attempt}`)
      .digest("hex");
    const candidate = `call_${ordinal.toString(36)}_${attempt.toString(36)}_${digest.slice(0, 32)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new HarnessError("CONTEXT_TOOL_ID", "Could not allocate a unique provider-safe tool call ID");
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

function repairToolBlocks(entries: ProjectedEntry[], provider: ProviderId): Map<string, ContentBlock | null> {
  const changes = new Map<string, ContentBlock | null>();
  const usedIds = new Set<string>();
  const lastUserIndex = entries.findLastIndex((entry) => entry.source.role === "user");
  let ordinal = 0;

  for (const group of messageGroups(entries)) {
    const calls = new Map<string, ToolBlockRef<ToolCallBlock>>();
    const results = new Map<ToolBlockRef<ToolCallBlock>, ToolBlockRef<ToolResultBlock>>();

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

    // A later user turn proves that an unmatched call was abandoned. Keep unmatched
    // calls in the active turn so compaction and recovery can still see them pending.
    const historical = (group.at(-1) ?? -1) < lastUserIndex;
    for (const call of calls.values()) {
      const result = results.get(call);
      if (result === undefined && historical) {
        changes.set(call.key, null);
        continue;
      }
      const original = call.block.callId;
      const assigned = targetSafeToolCallId(original) && !usedIds.has(original)
        ? original
        : replacementToolCallId(
          provider,
          original,
          entries[call.entryIndex]!.source.id,
          call.blockIndex,
          ordinal,
          usedIds,
        );
      ordinal += 1;
      usedIds.add(assigned);
      if (assigned !== original) {
        changes.set(call.key, { ...call.block, callId: assigned });
        if (result !== undefined) changes.set(result.key, { ...result.block, callId: assigned });
      }
    }
  }
  return changes;
}

export function projectMessagesForProvider(
  messages: readonly CanonicalMessage[],
  provider: ProviderId,
  options: ProviderProjectionOptions = {},
): CanonicalMessage[] {
  const entries = messages.map((message) => projectEntry(message, provider, options));
  const changes = repairToolBlocks(entries, provider);
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
  return projected;
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
        const imageMarkers = (block.images ?? []).map((image) => omittedImageText(image.mediaType));
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
