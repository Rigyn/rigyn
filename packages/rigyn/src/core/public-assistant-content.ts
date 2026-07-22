import type { AssistantMessage, ThinkingContent, ToolCall } from "@rigyn/models";

import { isJsonValue } from "./json.js";
import type {
  AssistantContentBlock,
  ContentBlock,
  ProviderState,
  ThinkingBlock,
  ToolCallBlock,
} from "./types.js";

/** Legacy reasoning carrier retained so existing session files remain readable. */
export const REASONING_MEDIA_TYPE = "application/vnd.rigyn.reasoning+json";

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

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label, { empty: true });
}

/** Validate and detach public assistant content before it enters canonical history. */
export function canonicalAssistantContent(
  value: AssistantMessage["content"] | unknown,
): AssistantContentBlock[] {
  if (!Array.isArray(value)) throw new TypeError("Assistant content must be an array");
  return value.map((raw, index): AssistantContentBlock => {
    const block = record(raw);
    if (block === undefined) throw new TypeError(`Assistant content ${index} must be an object`);
    if (block.type === "text") {
      const textSignature = optionalString(block.textSignature, `Assistant text signature ${index}`);
      return {
        type: "text",
        text: string(block.text, `Assistant text content ${index}`, { empty: true }),
        ...(textSignature === undefined ? {} : { textSignature }),
      };
    }
    if (block.type === "thinking") {
      const thinkingSignature = optionalString(block.thinkingSignature, `Assistant thinking signature ${index}`);
      if (block.redacted !== undefined && typeof block.redacted !== "boolean") {
        throw new TypeError(`Assistant thinking redacted marker ${index} must be boolean`);
      }
      return {
        type: "thinking",
        thinking: string(block.thinking, `Assistant thinking content ${index}`, { empty: true }),
        ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    }
    if (block.type !== "toolCall") throw new TypeError(`Assistant content ${index} has an unsupported type`);
    const argumentsValue = record(block.arguments);
    if (argumentsValue === undefined || !isJsonValue(argumentsValue)) {
      throw new TypeError(`Assistant tool-call arguments ${index} must be a JSON-safe object`);
    }
    const thoughtSignature = optionalString(block.thoughtSignature, `Assistant tool-call signature ${index}`);
    return {
      type: "tool_call",
      callId: string(block.id, `Assistant tool-call id ${index}`) as ToolCallBlock["callId"],
      name: string(block.name, `Assistant tool-call name ${index}`),
      arguments: structuredClone(argumentsValue),
      ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
    };
  });
}

/** Validate normalized terminal content supplied directly by an adapter. */
export function validatedAssistantContent(value: unknown): AssistantContentBlock[] {
  if (!Array.isArray(value)) throw new TypeError("Normalized assistant content must be an array");
  return value.map((raw, index): AssistantContentBlock => {
    const block = record(raw);
    if (block === undefined) throw new TypeError(`Normalized assistant content ${index} must be an object`);
    if (block.type === "text") {
      const textSignature = optionalString(block.textSignature, `Normalized text signature ${index}`);
      return {
        type: "text",
        text: string(block.text, `Normalized text content ${index}`, { empty: true }),
        ...(textSignature === undefined ? {} : { textSignature }),
      };
    }
    if (block.type === "thinking") {
      const thinkingSignature = optionalString(block.thinkingSignature, `Normalized thinking signature ${index}`);
      if (block.redacted !== undefined && typeof block.redacted !== "boolean") {
        throw new TypeError(`Normalized thinking redacted marker ${index} must be boolean`);
      }
      if (block.visibility !== undefined && block.visibility !== "summary" && block.visibility !== "provider_trace") {
        throw new TypeError(`Normalized thinking visibility ${index} is invalid`);
      }
      return {
        type: "thinking",
        thinking: string(block.thinking, `Normalized thinking content ${index}`, { empty: true }),
        ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
        ...(block.visibility === undefined ? {} : { visibility: block.visibility }),
      };
    }
    if (block.type !== "tool_call") throw new TypeError(`Normalized assistant content ${index} has an unsupported type`);
    const argumentsValue = block.arguments;
    if (!isJsonValue(argumentsValue)) throw new TypeError(`Normalized tool-call arguments ${index} must be JSON-safe`);
    const rawArguments = optionalString(block.rawArguments, `Normalized tool-call raw arguments ${index}`);
    const thoughtSignature = optionalString(block.thoughtSignature, `Normalized tool-call signature ${index}`);
    return {
      type: "tool_call",
      callId: string(block.callId, `Normalized tool-call id ${index}`) as ToolCallBlock["callId"],
      name: string(block.name, `Normalized tool-call name ${index}`),
      arguments: structuredClone(argumentsValue),
      ...(rawArguments === undefined ? {} : { rawArguments }),
      ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
    };
  });
}

function publicThinking(block: ContentBlock): ThinkingContent | undefined {
  if (block.type === "thinking") {
    return {
      type: "thinking",
      thinking: block.thinking,
      ...(block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature }),
      ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
    };
  }
  if (block.type !== "provider_opaque" || block.mediaType !== REASONING_MEDIA_TYPE) return undefined;
  const value = record(block.value);
  if (value === undefined || typeof value.thinking !== "string") return undefined;
  return {
    type: "thinking",
    thinking: value.thinking,
    ...(typeof value.thinkingSignature === "string" ? { thinkingSignature: value.thinkingSignature } : {}),
    ...(typeof value.redacted === "boolean" ? { redacted: value.redacted } : {}),
  };
}

/** Convert canonical assistant blocks to the one public message representation. */
export function publicAssistantContent(
  value: readonly ContentBlock[],
): AssistantMessage["content"] {
  const content: AssistantMessage["content"] = [];
  for (const block of value) {
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
    const thinking = publicThinking(block);
    if (thinking !== undefined) content.push(thinking);
  }
  return content;
}

/** Recover public terminal content carried by the normalized gateway continuation state. */
export function assistantContentFromProviderState(
  state: ProviderState,
): AssistantContentBlock[] | undefined {
  if (state.kind !== "gateway_messages") return undefined;
  return canonicalAssistantContent(state.assistantContent);
}

/** Add stream-only visibility to a detached canonical thinking block. */
export function withThinkingVisibility(
  block: ThinkingBlock,
  visibility: ThinkingBlock["visibility"],
): ThinkingBlock {
  return visibility === undefined ? block : { ...block, visibility };
}
