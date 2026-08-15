import type { RuntimeObservability } from "../core/observability.js";

export const OPENAI_CODEX_TRANSPORT_OBSERVER = Symbol("rigyn.openai-codex-transport-observer");

export type OpenAICodexTransportFailureClass =
  | "cancelled"
  | "close"
  | "connect"
  | "connect_timeout"
  | "http"
  | "idle_timeout"
  | "network"
  | "premature_end"
  | "protocol"
  | "provider"
  | "provider_control"
  | "send"
  | "unknown";

export type OpenAICodexOutputBoundary =
  | "visible_text"
  | "visible_summary_reasoning"
  | "hidden_provider_reasoning"
  | "tool_draft"
  | "unknown_or_opaque";

export type OpenAICodexTransportObservation =
  | {
      type: "selected";
      transport: "sse";
      sessionFallbackUsed: boolean;
    }
  | {
      type: "selected";
      transport: "websocket";
      cachedSocketReused: boolean;
      handshakeStatus: 101;
    }
  | {
      type: "websocket_failed";
      failureClass: OpenAICodexTransportFailureClass;
      closeCode?: number;
      transportCode?: string;
      partialOutput: boolean;
      outputBoundary?: OpenAICodexOutputBoundary;
    }
  | {
      type: "session_fallback_activated";
      failureClass: OpenAICodexTransportFailureClass;
      partialOutput: boolean;
      outputBoundary?: OpenAICodexOutputBoundary;
    };

export type OpenAICodexTransportObserver = (observation: OpenAICodexTransportObservation) => void;

export interface OpenAICodexObservabilityOptions {
  [OPENAI_CODEX_TRANSPORT_OBSERVER]?: OpenAICodexTransportObserver;
}

export function runtimeOpenAICodexTransportObserver(
  observability: RuntimeObservability | (() => RuntimeObservability | undefined),
): OpenAICodexTransportObserver {
  return (observation) => {
    const selected = typeof observability === "function" ? observability() : observability;
    if (selected === undefined) return;
    switch (observation.type) {
      case "selected":
        selected.event("provider", "codex_transport_selected", observation.transport === "sse"
          ? {
              transport: observation.transport,
              session_fallback_used: observation.sessionFallbackUsed,
            }
          : {
              transport: observation.transport,
              cached_socket_reused: observation.cachedSocketReused,
              websocket_handshake_status: observation.handshakeStatus,
            }, "debug");
        return;
      case "websocket_failed":
        selected.event("provider", "codex_websocket_failed", {
          failure_class: observation.failureClass,
          partial_output: observation.partialOutput,
          ...(observation.outputBoundary === undefined ? {} : { output_boundary: observation.outputBoundary }),
          ...(observation.closeCode === undefined ? {} : { websocket_close_code: observation.closeCode }),
          ...(observation.transportCode === undefined ? {} : { transport_code: observation.transportCode }),
        }, "error");
        return;
      case "session_fallback_activated":
        selected.event("provider", "codex_session_fallback_activated", {
          failure_class: observation.failureClass,
          partial_output: observation.partialOutput,
          ...(observation.outputBoundary === undefined ? {} : { output_boundary: observation.outputBoundary }),
        });
    }
  };
}
