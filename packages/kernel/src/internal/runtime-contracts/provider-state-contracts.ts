import type { JsonValue } from "../../runtime/core/json.js";
import type { ModelProtocolFamily } from "./model-contracts.js";
import type { ProviderId } from "./provider-identity.js";

export interface RoutedProviderStateProvenance {
  provider: ProviderId;
  model: string;
  delegate: ProviderId;
  upstreamModel: string;
  protocolFamily: ModelProtocolFamily;
  scope: string;
}

export interface ProviderStateSource {
  provider: ProviderId;
  model: string;
  api: ModelProtocolFamily;
}

type NativeProviderState =
  | { kind: "openai_responses"; previousResponseId?: string; outputItems: JsonValue[] }
  | { kind: "anthropic_messages"; assistantBlocks: JsonValue[] }
  | { kind: "gemini_interactions"; previousInteractionId?: string; steps: JsonValue[] }
  | { kind: "gemini_generate_content"; parts: JsonValue[] }
  | { kind: "extension_stream"; assistantContent: JsonValue[]; responseId?: string }
  | { kind: "bedrock_converse"; assistantMessage: JsonValue }
  | { kind: "chat_completions"; assistantMessage: JsonValue }
  | { kind: "openrouter_chat"; assistantMessage: JsonValue }
  | { kind: "ollama_chat"; assistantMessage: JsonValue };

export type ProviderState = NativeProviderState & {
  /** Exact model boundary that produced this replayable wire state. */
  source?: ProviderStateSource;
  /** Exact routed-adapter generation that produced this continuation state. */
  routed?: RoutedProviderStateProvenance;
};
