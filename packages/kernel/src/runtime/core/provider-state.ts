import { isDeepStrictEqual } from "node:util";

import { ASSISTANT_CONTENT_LIMITS } from "./assistant-content-limits.js";
import { boundedJsonSnapshot } from "./bounded-json.js";
import type { JsonValue } from "./json.js";
import type { CanonicalMessage, ModelProtocolFamily, ProviderState } from "./types.js";

const MODEL_PROTOCOL_FAMILIES = new Set<ModelProtocolFamily>([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "gemini-generate-content",
  "gemini-interactions",
  "bedrock-converse",
  "ollama-chat",
  "extension-stream",
]);

const PROVIDER_STATE_SHAPES = Object.freeze({
  openai_responses: { value: "outputItems", array: true, id: "previousResponseId", api: "openai-responses" },
  anthropic_messages: { value: "assistantBlocks", array: true, api: "anthropic-messages" },
  gemini_interactions: { value: "steps", array: true, id: "previousInteractionId", api: "gemini-interactions" },
  gemini_generate_content: { value: "parts", array: true, api: "gemini-generate-content" },
  extension_stream: { value: "assistantContent", array: true, id: "responseId", api: "extension-stream" },
  bedrock_converse: { value: "assistantMessage", array: false, api: "bedrock-converse" },
  chat_completions: { value: "assistantMessage", array: false, api: "openai-chat-completions" },
  openrouter_chat: { value: "assistantMessage", array: false, api: "openai-chat-completions" },
  ollama_chat: { value: "assistantMessage", array: false, api: "ollama-chat" },
} as const satisfies Record<string, {
  value: string;
  array: boolean;
  id?: string;
  api: ModelProtocolFamily;
}>);

export interface ValidatedProviderState {
  state: ProviderState;
  serialized: string;
  api: ModelProtocolFamily;
}

function invalidProviderState(): never {
  throw new TypeError("Provider continuation state is invalid");
}

function providerStateRecord(value: JsonValue | undefined, fields: readonly string[]): Record<string, JsonValue> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidProviderState();
  }
  const record = value as Record<string, JsonValue>;
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    return invalidProviderState();
  }
  return record;
}

function providerStateIdentity(value: JsonValue | undefined): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 4_096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return invalidProviderState();
  }
  return value;
}

function validateProviderStateProvenance(
  record: Record<string, JsonValue>,
  expectedApi: ModelProtocolFamily,
): void {
  if (record.source !== undefined) {
    const source = providerStateRecord(record.source, ["provider", "model", "api"]);
    providerStateIdentity(source.provider);
    providerStateIdentity(source.model);
    if (typeof source.api !== "string" || !MODEL_PROTOCOL_FAMILIES.has(source.api as ModelProtocolFamily)
      || source.api !== expectedApi) {
      invalidProviderState();
    }
  }
  if (record.routed !== undefined) {
    const routed = providerStateRecord(record.routed, [
      "provider",
      "model",
      "delegate",
      "upstreamModel",
      "protocolFamily",
      "scope",
    ]);
    providerStateIdentity(routed.provider);
    providerStateIdentity(routed.model);
    providerStateIdentity(routed.delegate);
    providerStateIdentity(routed.upstreamModel);
    providerStateIdentity(routed.scope);
    if (typeof routed.protocolFamily !== "string"
      || !MODEL_PROTOCOL_FAMILIES.has(routed.protocolFamily as ModelProtocolFamily)
      || routed.protocolFamily !== expectedApi) {
      invalidProviderState();
    }
  }
}

/** Validates and detaches opaque continuation state before it crosses a provider boundary. */
export function validateProviderState(value: unknown): ValidatedProviderState {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Provider continuation state",
    maximumBytes: ASSISTANT_CONTENT_LIMITS.contentBytes,
    maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
    maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
    maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
  });
  if (snapshot.value === null || typeof snapshot.value !== "object" || Array.isArray(snapshot.value)) {
    return invalidProviderState();
  }
  const record = snapshot.value as Record<string, JsonValue>;
  const kind = record.kind;
  if (typeof kind !== "string" || !Object.hasOwn(PROVIDER_STATE_SHAPES, kind)) {
    return invalidProviderState();
  }
  const shape = PROVIDER_STATE_SHAPES[kind as keyof typeof PROVIDER_STATE_SHAPES];
  const stateId = "id" in shape ? shape.id : undefined;
  const allowed = new Set(["kind", shape.value, "source", "routed", ...(stateId === undefined ? [] : [stateId])]);
  if (Object.keys(record).some((field) => !allowed.has(field)) || !Object.hasOwn(record, shape.value)) {
    return invalidProviderState();
  }
  if (shape.array && !Array.isArray(record[shape.value])) return invalidProviderState();
  if (stateId !== undefined && record[stateId] !== undefined) providerStateIdentity(record[stateId]);
  validateProviderStateProvenance(record, shape.api);
  return {
    state: snapshot.value as unknown as ProviderState,
    serialized: snapshot.serialized,
    api: shape.api,
  };
}

export interface ReconciledProviderState {
  providerState?: ProviderState;
  providerStateMessageId?: string;
}

export function replayProviderStateAfterPrefixRewrite(state: ProviderState): ProviderState | undefined {
  if (state.kind === "openai_responses") {
    if (state.outputItems.length === 0) return undefined;
    const { previousResponseId: _previousResponseId, ...replayable } = state;
    return replayable;
  }
  if (state.kind === "gemini_interactions") {
    if (state.steps.length === 0) return undefined;
    const { previousInteractionId: _previousInteractionId, ...replayable } = state;
    return replayable;
  }
  return state;
}

export function reconcileProviderStateAfterContextRewrite(
  state: ProviderState | undefined,
  stateMessageId: string | undefined,
  previousMessages: readonly CanonicalMessage[],
  nextMessages: readonly CanonicalMessage[],
): ReconciledProviderState {
  if (state === undefined || stateMessageId === undefined) return {};
  const previousIndex = previousMessages.findIndex((message) => message.id === stateMessageId);
  const nextIndex = nextMessages.findIndex((message) => message.id === stateMessageId);
  if (
    previousIndex < 0 ||
    nextIndex < 0 ||
    !isDeepStrictEqual(previousMessages[previousIndex], nextMessages[nextIndex])
  ) return {};
  if (
    previousIndex === nextIndex &&
    isDeepStrictEqual(
      previousMessages.slice(0, previousIndex + 1),
      nextMessages.slice(0, nextIndex + 1),
    )
  ) {
    return { providerState: state, providerStateMessageId: stateMessageId };
  }
  const replayable = replayProviderStateAfterPrefixRewrite(state);
  return replayable === undefined
    ? {}
    : { providerState: replayable, providerStateMessageId: stateMessageId };
}
