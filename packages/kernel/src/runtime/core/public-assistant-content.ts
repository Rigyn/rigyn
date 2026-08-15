import { isProxy } from "node:util/types";

import type { AssistantMessage, ThinkingContent, ToolCall } from "@rigyn/models";

import { ASSISTANT_CONTENT_LIMITS } from "./assistant-content-limits.js";
import { boundedJsonSnapshot } from "./bounded-json.js";
import {
  MAX_TOOL_CALL_STREAM_ID_BYTES,
  MAX_TOOL_CALL_STREAM_NAME_BYTES,
} from "./events.js";
import type { JsonValue } from "./json.js";
import { validateProviderState } from "./provider-state.js";
import type {
  AssistantContentBlock,
  ContentBlock,
  ProviderState,
  ThinkingBlock,
  ToolCallBlock,
} from "./types.js";

/** Opaque media type for provider reasoning blocks in canonical assistant content. */
export const REASONING_MEDIA_TYPE = "application/vnd.rigyn.reasoning+json";

const ASSISTANT_CONTENT_ENVELOPE_BYTES = 64 * 1024 * 1024;
const ASSISTANT_CONTENT_ENVELOPE_VALUES = 16 * 1024;
const ASSISTANT_CONTENT_ENVELOPE_DEPTH = ASSISTANT_CONTENT_LIMITS.argumentDepth + 3;

function assistantContentSnapshot(value: unknown, label: string): JsonValue[] {
  if (value !== null && typeof value === "object" && isProxy(value)) {
    throw new TypeError(`${label} must not contain proxies`);
  }
  if (value === null || typeof value !== "object" || !Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a vanilla array`);
  }
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new TypeError(`${label} must be a dense vanilla array`);
  }
  if ((length as number) > ASSISTANT_CONTENT_LIMITS.blocks) {
    throw new TypeError(`${label} must contain at most ${ASSISTANT_CONTENT_LIMITS.blocks} blocks`);
  }
  const selected = boundedJsonSnapshot(value, {
    label,
    maximumBytes: ASSISTANT_CONTENT_ENVELOPE_BYTES,
    maximumValues: ASSISTANT_CONTENT_ENVELOPE_VALUES,
    maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
    maximumDepth: ASSISTANT_CONTENT_ENVELOPE_DEPTH,
  }).value;
  if (!Array.isArray(selected)) throw new TypeError(`${label} must be an array`);
  return selected;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown, label: string, options: { empty?: boolean } = {}): string {
  if (typeof value !== "string" || value.includes("\0") || (options.empty !== true && value.trim() === "")) {
    throw new TypeError(`${label} must be ${options.empty === true ? "a" : "a non-empty"} string without NUL bytes`);
  }
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximumBytes: number,
  options: { empty?: boolean } = {},
): string {
  const selected = string(value, label, options);
  if (Buffer.byteLength(selected, "utf8") > maximumBytes) {
    throw new TypeError(`${label} exceeds ${maximumBytes} bytes`);
  }
  return selected;
}

function optionalBoundedString(value: unknown, label: string, maximumBytes: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maximumBytes, { empty: true });
}

function assertBlockCount(value: readonly unknown[], label: string): void {
  if (value.length > ASSISTANT_CONTENT_LIMITS.blocks) {
    throw new TypeError(`${label} must contain at most ${ASSISTANT_CONTENT_LIMITS.blocks} blocks`);
  }
  let descriptors: { [key: string]: PropertyDescriptor };
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(`${label} could not be inspected safely`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined) throw new TypeError(`${label} must not be sparse`);
    if (!("value" in descriptor)) throw new TypeError(`${label} must not contain accessors`);
  }
}

function nextContainerCount(current: number, label: string): number {
  const next = current + 1;
  if (next > ASSISTANT_CONTENT_LIMITS.containers) {
    throw new TypeError(`${label} must contain at most ${ASSISTANT_CONTENT_LIMITS.containers} container values`);
  }
  return next;
}

function validateJsonArgument(
  currentContainers: number,
  currentValues: number,
  value: unknown,
  label: string,
): { containers: number; values: number } {
  const pending: Array<{ value: unknown; depth: number; leave?: object }> = [{ value, depth: 0 }];
  const active = new WeakSet<object>();
  let containers = currentContainers;
  let values = currentValues;
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.leave !== undefined) {
      active.delete(frame.leave);
      continue;
    }
    const selected = frame.value;
    values += 1;
    if (values > ASSISTANT_CONTENT_LIMITS.argumentValues) {
      throw new TypeError(`${label} must contain at most ${ASSISTANT_CONTENT_LIMITS.argumentValues} JSON values`);
    }
    if (
      selected === null || typeof selected === "string" || typeof selected === "boolean" ||
      (typeof selected === "number" && Number.isFinite(selected))
    ) continue;
    if (typeof selected !== "object") throw new TypeError(`${label} must be JSON-safe`);
    if (frame.depth > ASSISTANT_CONTENT_LIMITS.argumentDepth) {
      throw new TypeError(`${label} must be nested at most ${ASSISTANT_CONTENT_LIMITS.argumentDepth} levels`);
    }
    if (active.has(selected)) throw new TypeError(`${label} must not contain cycles`);
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(selected) as object | null;
    } catch {
      throw new TypeError(`${label} could not be inspected safely`);
    }
    if (!Array.isArray(selected) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must be JSON-safe`);
    }
    if (Array.isArray(selected) && selected.length > ASSISTANT_CONTENT_LIMITS.containers) {
      throw new TypeError(`${label} must contain at most ${ASSISTANT_CONTENT_LIMITS.containers} array items`);
    }
    containers = nextContainerCount(containers, label);
    active.add(selected);
    pending.push({ value: undefined, depth: frame.depth, leave: selected });
    let descriptors: Record<PropertyKey, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(selected);
    } catch {
      throw new TypeError(`${label} could not be inspected safely`);
    }
    const children = Array.isArray(selected)
      ? Array.from({ length: selected.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined) throw new TypeError(`${label} must not contain sparse arrays`);
          if (!("value" in descriptor)) throw new TypeError(`${label} must not contain accessors`);
          return descriptor;
        })
      : Object.values(descriptors).filter((descriptor) => descriptor.enumerable === true);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const descriptor = children[index]!;
      if (!("value" in descriptor)) throw new TypeError(`${label} must not contain accessors`);
      pending.push({ value: descriptor.value, depth: frame.depth + 1 });
    }
  }
  return { containers, values };
}

function cloneJsonArgument(value: unknown, label: string): JsonValue {
  try {
    return structuredClone(value) as JsonValue;
  } catch {
    throw new TypeError(`${label} could not be detached safely`);
  }
}

function serializedArgumentBytes(value: unknown, label: string): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > ASSISTANT_CONTENT_LIMITS.fieldBytes) {
    throw new TypeError(`${label} exceeds ${ASSISTANT_CONTENT_LIMITS.fieldBytes} bytes`);
  }
  return bytes;
}

function addPayloadBytes(current: number, value: string | number | undefined, label: string): number {
  const next = current + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : value ?? 0);
  if (next > ASSISTANT_CONTENT_LIMITS.contentBytes) {
    throw new TypeError(`${label} exceeds ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate bytes`);
  }
  return next;
}

/** Validate and detach public assistant content before it enters canonical history. */
export function canonicalAssistantContent(
  value: AssistantMessage["content"] | unknown,
): AssistantContentBlock[] {
  const source = assistantContentSnapshot(value, "Assistant content");
  assertBlockCount(source, "Assistant content");
  let containers = 1;
  let argumentValues = 0;
  let payloadBytes = 0;
  const content = source.map((raw, index): AssistantContentBlock => {
    const block = record(raw);
    if (block === undefined) throw new TypeError(`Assistant content ${index} must be an object`);
    containers = nextContainerCount(containers, "Assistant content");
    if (block.type === "text") {
      const text = boundedString(
        block.text,
        `Assistant text content ${index}`,
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
        { empty: true },
      );
      const textSignature = optionalBoundedString(
        block.textSignature,
        `Assistant text signature ${index}`,
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      payloadBytes = addPayloadBytes(payloadBytes, text, "Assistant content");
      payloadBytes = addPayloadBytes(payloadBytes, textSignature, "Assistant content");
      return {
        type: "text",
        text,
        ...(textSignature === undefined ? {} : { textSignature }),
      };
    }
    if (block.type === "thinking") {
      const thinking = boundedString(
        block.thinking,
        `Assistant thinking content ${index}`,
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
        { empty: true },
      );
      const thinkingSignature = optionalBoundedString(
        block.thinkingSignature,
        `Assistant thinking signature ${index}`,
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      if (block.redacted !== undefined && typeof block.redacted !== "boolean") {
        throw new TypeError(`Assistant thinking redacted marker ${index} must be boolean`);
      }
      payloadBytes = addPayloadBytes(payloadBytes, thinking, "Assistant content");
      payloadBytes = addPayloadBytes(payloadBytes, thinkingSignature, "Assistant content");
      return {
        type: "thinking",
        thinking,
        ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    }
    if (block.type !== "toolCall") throw new TypeError(`Assistant content ${index} has an unsupported type`);
    const argumentsValue = record(block.arguments);
    if (argumentsValue === undefined) {
      throw new TypeError(`Assistant tool-call arguments ${index} must be a JSON-safe object`);
    }
    ({ containers, values: argumentValues } = validateJsonArgument(
      containers,
      argumentValues,
      argumentsValue,
      "Assistant content",
    ));
    const detachedArguments = cloneJsonArgument(argumentsValue, `Assistant tool-call arguments ${index}`);
    const argumentBytes = serializedArgumentBytes(detachedArguments, `Assistant tool-call serialized arguments ${index}`);
    const thoughtSignature = optionalBoundedString(
      block.thoughtSignature,
      `Assistant tool-call signature ${index}`,
      ASSISTANT_CONTENT_LIMITS.fieldBytes,
    );
    payloadBytes = addPayloadBytes(payloadBytes, argumentBytes, "Assistant content");
    payloadBytes = addPayloadBytes(payloadBytes, thoughtSignature, "Assistant content");
    return {
      type: "tool_call",
      callId: boundedString(
        block.id,
        `Assistant tool-call id ${index}`,
        MAX_TOOL_CALL_STREAM_ID_BYTES,
      ) as ToolCallBlock["callId"],
      name: boundedString(block.name, `Assistant tool-call name ${index}`, MAX_TOOL_CALL_STREAM_NAME_BYTES),
      arguments: detachedArguments,
      ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
    };
  });
  return content;
}

/** Validate normalized terminal content supplied directly by an adapter. */
export function validatedAssistantContent(value: unknown): AssistantContentBlock[] {
  const source = assistantContentSnapshot(value, "Normalized assistant content");
  assertBlockCount(source, "Normalized assistant content");
  let containers = 1;
  let argumentValues = 0;
  let payloadBytes = 0;
  const content = source.map((raw, index): AssistantContentBlock => {
    const block = record(raw);
    if (block === undefined) throw new TypeError(`Normalized assistant content ${index} must be an object`);
    containers = nextContainerCount(containers, "Normalized assistant content");
    if (block.type === "text") {
      const text = boundedString(
        block.text,
        `Normalized text content ${index}`,
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
        { empty: true },
      );
      const textSignature = optionalBoundedString(
        block.textSignature,
        `Normalized text signature ${index}`,
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      payloadBytes = addPayloadBytes(payloadBytes, text, "Normalized assistant content");
      payloadBytes = addPayloadBytes(payloadBytes, textSignature, "Normalized assistant content");
      return {
        type: "text",
        text,
        ...(textSignature === undefined ? {} : { textSignature }),
      };
    }
    if (block.type === "thinking") {
      const thinking = boundedString(
        block.thinking,
        `Normalized thinking content ${index}`,
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
        { empty: true },
      );
      const thinkingSignature = optionalBoundedString(
        block.thinkingSignature,
        `Normalized thinking signature ${index}`,
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
      );
      if (block.redacted !== undefined && typeof block.redacted !== "boolean") {
        throw new TypeError(`Normalized thinking redacted marker ${index} must be boolean`);
      }
      if (block.visibility !== undefined && block.visibility !== "summary" && block.visibility !== "provider_trace") {
        throw new TypeError(`Normalized thinking visibility ${index} is invalid`);
      }
      payloadBytes = addPayloadBytes(payloadBytes, thinking, "Normalized assistant content");
      payloadBytes = addPayloadBytes(payloadBytes, thinkingSignature, "Normalized assistant content");
      return {
        type: "thinking",
        thinking,
        ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
        ...(block.visibility === undefined ? {} : { visibility: block.visibility }),
      };
    }
    if (block.type !== "tool_call") throw new TypeError(`Normalized assistant content ${index} has an unsupported type`);
    const argumentsValue = block.arguments;
    ({ containers, values: argumentValues } = validateJsonArgument(
      containers,
      argumentValues,
      argumentsValue,
      "Normalized assistant content",
    ));
    const detachedArguments = cloneJsonArgument(argumentsValue, `Normalized tool-call arguments ${index}`);
    const argumentBytes = serializedArgumentBytes(detachedArguments, `Normalized tool-call serialized arguments ${index}`);
    const rawArguments = optionalBoundedString(
      block.rawArguments,
      `Normalized tool-call raw arguments ${index}`,
      ASSISTANT_CONTENT_LIMITS.fieldBytes,
    );
    const thoughtSignature = optionalBoundedString(
      block.thoughtSignature,
      `Normalized tool-call signature ${index}`,
      ASSISTANT_CONTENT_LIMITS.fieldBytes,
    );
    payloadBytes = addPayloadBytes(payloadBytes, argumentBytes, "Normalized assistant content");
    payloadBytes = addPayloadBytes(payloadBytes, rawArguments, "Normalized assistant content");
    payloadBytes = addPayloadBytes(payloadBytes, thoughtSignature, "Normalized assistant content");
    return {
      type: "tool_call",
      callId: boundedString(
        block.callId,
        `Normalized tool-call id ${index}`,
        MAX_TOOL_CALL_STREAM_ID_BYTES,
      ) as ToolCallBlock["callId"],
      name: boundedString(block.name, `Normalized tool-call name ${index}`, MAX_TOOL_CALL_STREAM_NAME_BYTES),
      arguments: detachedArguments,
      ...(rawArguments === undefined ? {} : { rawArguments }),
      ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
    };
  });
  return content;
}

/** Convert canonical assistant blocks to the one public message representation. */
export function publicAssistantContent(
  value: readonly ContentBlock[],
): AssistantMessage["content"] {
  const source = assistantContentSnapshot(value, "Public assistant content");
  const selected: unknown[] = [];
  for (const raw of source) {
    const block = record(raw);
    if (block === undefined) throw new TypeError("Public assistant content blocks must be objects");
    if (block.type === "text" || block.type === "thinking" || block.type === "tool_call") {
      selected.push(block);
      continue;
    }
    if (block.type !== "provider_opaque" || block.mediaType !== REASONING_MEDIA_TYPE) continue;
    const opaque = record(block.value);
    if (opaque === undefined || typeof opaque.thinking !== "string") continue;
    selected.push({
      type: "thinking",
      thinking: opaque.thinking,
      ...(typeof opaque.thinkingSignature === "string" ? { thinkingSignature: opaque.thinkingSignature } : {}),
      ...(typeof opaque.redacted === "boolean" ? { redacted: opaque.redacted } : {}),
    });
  }

  const content: AssistantMessage["content"] = [];
  for (const block of validatedAssistantContent(selected)) {
    if (block.type === "text") {
      content.push({
        type: "text",
        text: block.text,
        ...(block.textSignature === undefined ? {} : { textSignature: block.textSignature }),
      });
      continue;
    }
    if (block.type === "tool_call") {
      const argumentsValue = record(block.arguments) ?? {};
      const call: ToolCall = {
        type: "toolCall",
        id: block.callId,
        name: block.name,
        arguments: structuredClone(argumentsValue),
        ...(block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature }),
      };
      content.push(call);
      continue;
    }
    if (block.visibility === "provider_trace") continue;
    const thinking: ThinkingContent = {
      type: "thinking",
      thinking: block.thinking,
      ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
      ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
    };
    content.push(thinking);
  }
  return content;
}

/** Recover public terminal content carried by an extension stream continuation. */
export function assistantContentFromProviderState(
  state: ProviderState,
): AssistantContentBlock[] | undefined {
  const selected = validateProviderState(state).state;
  if (selected.kind !== "extension_stream") return undefined;
  return canonicalAssistantContent(selected.assistantContent);
}

/** Add stream-only visibility to a detached canonical thinking block. */
export function withThinkingVisibility(
  block: ThinkingBlock,
  visibility: ThinkingBlock["visibility"],
): ThinkingBlock {
  return visibility === undefined ? block : { ...block, visibility };
}
