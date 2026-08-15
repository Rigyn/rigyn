import type { AssistantMessageDiagnostic } from "@rigyn/models";

import type { AssistantContentBlock } from "./canonical-content.js";
import type { JsonValue } from "../../runtime/core/json.js";
import type { AdapterError, ProviderResponseDiagnostics } from "./provider-diagnostic-contracts.js";
import type { FinishReason, ProviderId } from "./provider-identity.js";
import type { ProviderState } from "./provider-state-contracts.js";
import type { NormalizedUsage } from "./usage-contracts.js";

export type AdapterEvent =
  | {
      type: "response_start";
      model: string;
      responseId?: string;
      requestId?: string;
      diagnostics?: ProviderResponseDiagnostics;
    }
  | { type: "text_start"; part: number }
  | { type: "text_delta"; part: number; text: string }
  | { type: "text_end"; part: number; text: string; textSignature?: string }
  | { type: "reasoning_start"; part: number; visibility: "summary" | "provider_trace" }
  | {
      type: "reasoning_delta";
      part: number;
      text: string;
      visibility: "summary" | "provider_trace";
    }
  | {
      type: "reasoning_end";
      part: number;
      text: string;
      visibility: "summary" | "provider_trace";
      thinkingSignature?: string;
      redacted?: boolean;
    }
  | { type: "tool_call_start"; index: number; id?: string; name?: string }
  | { type: "tool_call_delta"; index: number; jsonFragment: string }
  | {
      type: "tool_call_end";
      index: number;
      name: string;
      rawArguments: string;
      id?: string;
      arguments?: JsonValue;
      parseError?: string;
      thoughtSignature?: string;
    }
  | {
      type: "usage";
      usage: NormalizedUsage;
      semantics: "incremental" | "cumulative" | "final";
    }
  | { type: "unknown_provider_event"; provider: ProviderId; raw: JsonValue }
  | {
      type: "response_end";
      reason: FinishReason;
      state: ProviderState;
      /** Validated ordered terminal assistant content, when the protocol exposes it. */
      content?: AssistantContentBlock[];
      /** Bounded public diagnostic records emitted by a provider implementation. */
      assistantDiagnostics?: AssistantMessageDiagnostic[];
      rawReason?: string;
      /** Bounded, provider-authored explanation for a non-success finish such as a refusal. */
      explanation?: string;
    }
  | { type: "error"; error: AdapterError };
