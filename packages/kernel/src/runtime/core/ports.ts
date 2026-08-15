import type { EventSink } from "./events.js";
import type { RunId, ThreadId } from "./ids.js";
import type { CanonicalMessage, ProviderId, ProviderState } from "./types.js";
import type { ContextUsageBaseline, ProviderProjectionOptions } from "../context/projection.js";

export interface ConversationContext {
  messages: CanonicalMessage[];
  providerState?: ProviderState;
  providerStateMessageId?: string;
  toolDefinitionFingerprint?: string;
  usageBaseline?: ContextUsageBaseline;
}

export interface ConversationPort {
  loadContext(
    threadId: ThreadId,
    branch: string | undefined,
    provider: ProviderId,
    signal: AbortSignal,
    model?: string,
    projection?: ProviderProjectionOptions,
  ): Promise<ConversationContext>;
}

export interface RunEventSinkFactory {
  create(threadId: ThreadId, runId: RunId, branch?: string): EventSink;
}
