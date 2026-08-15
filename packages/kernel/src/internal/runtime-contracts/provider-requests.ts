import type { SimpleStreamOptions, Transport } from "@rigyn/models";

import type { AdapterEvent } from "./adapter-events.js";
import type { CanonicalMessage, ProviderToolDefinition } from "./canonical-content.js";
import type {
  ModelInfo,
  ModelProtocolFamily,
  ModelRequestCompatibility,
  ProviderCacheRetention,
} from "./model-contracts.js";
import type { ProviderId } from "./provider-identity.js";
import type { ProviderState } from "./provider-state-contracts.js";

/** Host-injected model settings. Authentication headers are never accepted here. */
export interface ProviderModelRequestSettings {
  /** Human-readable model name used only for protocol capability detection. */
  displayName?: string;
  headers?: Record<string, string>;
  reasoningEffortMap?: Record<string, string | null>;
  compatibility?: ModelRequestCompatibility;
}

export interface ProviderRequest {
  provider: ProviderId;
  model: string;
  api?: ModelProtocolFamily;
  messages: CanonicalMessage[];
  tools: ProviderToolDefinition[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  cacheRetention?: ProviderCacheRetention;
  providerState?: ProviderState;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  /** Optional operator budgets for provider protocols that express reasoning in tokens. */
  thinkingBudgets?: ThinkingBudgets;
  metadata?: Record<string, string>;
  sessionId?: string;
  transport?: Transport;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  /** Supplied by the provider registry after extension request reducers have completed. */
  modelSettings?: ProviderModelRequestSettings;
}

export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
  xhigh?: number;
  max?: number;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  dispose?(): Promise<void> | void;
}
