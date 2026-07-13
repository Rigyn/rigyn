import type { ConversationContext, ConversationPort } from "../core/ports.js";
import type { CanonicalMessage, ProviderId, ProviderState } from "../core/types.js";
import { normalizedContextTokens } from "../core/usage.js";
import { extensionMessageContext } from "../core/extension-entries.js";
import { projectMessagesForProvider } from "../context/projection.js";
import type { ContextUsageBaseline, ProviderProjectionOptions } from "../context/projection.js";
import type { SessionStore } from "../storage/store.js";
import type { ArtifactWriter, ToolArtifact } from "../tools/types.js";

function applyCompactionView(messages: CanonicalMessage[], summary: CanonicalMessage, sourceIds: string[]): void {
  const selected = new Set(sourceIds);
  const indices = messages.flatMap((entry, index) => selected.has(entry.id) ? [index] : []);
  if (indices.length !== selected.size) throw new Error("Compaction references missing or duplicate source messages");
  const insertion = Math.min(...indices);
  const retained = messages.filter((entry) => !selected.has(entry.id));
  const removedBefore = indices.filter((index) => index < insertion).length;
  retained.splice(insertion - removedBefore, 0, summary);
  messages.splice(0, messages.length, ...retained);
}

export class StoredConversation implements ConversationPort {
  readonly #store: SessionStore;

  constructor(store: SessionStore) {
    this.#store = store;
  }

  async loadContext(
    threadId: string,
    branch: string | undefined,
    provider: ProviderId,
    signal: AbortSignal,
    model?: string,
    projection: ProviderProjectionOptions = {},
  ): Promise<ConversationContext> {
    signal.throwIfAborted();
    const events = this.#store.listEvents(threadId, branch);
    const messages: CanonicalMessage[] = [];
    const excludedAssistantIds = new Set<string>();
    const assistantByRun = new Map<string, string>();
    const runModels = new Map<string, { provider: ProviderId; model: string }>();
    const compactingRuns = new Set<string>();
    let usageBaseline: ContextUsageBaseline | undefined;
    let providerState: ProviderState | undefined;
    let providerStateMessageId: string | undefined;
    let toolDefinitionFingerprint: string | undefined;
    for (const envelope of events) {
      signal.throwIfAborted();
      if (envelope.event.type === "run_started" && envelope.runId !== undefined) {
        runModels.set(envelope.runId, { provider: envelope.event.provider, model: envelope.event.model });
      } else if (envelope.event.type === "compaction_started" && envelope.runId !== undefined) {
        compactingRuns.add(envelope.runId);
      } else if (envelope.event.type === "usage" && envelope.runId !== undefined) {
        const run = runModels.get(envelope.runId);
        const usage = envelope.event.usage;
        const inputTokens = normalizedContextTokens(usage);
        if (
          model !== undefined &&
          run?.provider === provider &&
          run.model === model &&
          !compactingRuns.has(envelope.runId) &&
          envelope.event.semantics !== "incremental" &&
          inputTokens !== undefined &&
          Number.isSafeInteger(inputTokens) &&
          inputTokens >= 0
        ) {
          usageBaseline = {
            provider,
            model,
            inputTokens,
            prefixMessageIds: messages.map((message) => message.id),
          };
        }
      } else if (envelope.event.type === "message_appended") {
        messages.push(envelope.event.message);
        if (envelope.event.message.role === "assistant") {
          if (envelope.runId !== undefined) assistantByRun.set(envelope.runId, envelope.event.message.id);
          if (envelope.event.message.provider === provider && envelope.event.providerState !== undefined) {
            providerState = envelope.event.providerState;
            providerStateMessageId = envelope.event.message.id;
            toolDefinitionFingerprint = envelope.event.toolDefinitionFingerprint;
          } else {
            providerState = undefined;
            providerStateMessageId = undefined;
            toolDefinitionFingerprint = undefined;
          }
        }
      } else if (envelope.event.type === "extension_message") {
        const message = extensionMessageContext(envelope.event, envelope.timestamp);
        if (message !== undefined) messages.push(message);
      } else if (envelope.event.type === "branch_summary_created") {
        messages.push(envelope.event.summary);
      } else if (envelope.event.type === "assistant_completed") {
        const assistantId = envelope.runId === undefined ? undefined : assistantByRun.get(envelope.runId);
        if (
          assistantId !== undefined &&
          ["error", "cancelled", "incomplete"].includes(envelope.event.finishReason)
        ) {
          excludedAssistantIds.add(assistantId);
          if (providerStateMessageId === assistantId) {
            providerState = undefined;
            providerStateMessageId = undefined;
            toolDefinitionFingerprint = undefined;
          }
        }
        if (envelope.runId !== undefined) assistantByRun.delete(envelope.runId);
      } else if (envelope.event.type === "compaction_completed") {
        if (envelope.runId !== undefined) compactingRuns.delete(envelope.runId);
        applyCompactionView(messages, envelope.event.summary, envelope.event.sourceMessageIds);
        if (providerStateMessageId !== undefined && envelope.event.sourceMessageIds.includes(providerStateMessageId)) {
          providerState = undefined;
          providerStateMessageId = undefined;
          toolDefinitionFingerprint = undefined;
        }
      }
    }
    const latestInstructions = messages.findLastIndex((entry) => entry.purpose === "instructions");
    const active = messages.filter((entry, index) =>
      !excludedAssistantIds.has(entry.id) && (entry.purpose !== "instructions" || index === latestInstructions)
    );
    const current = [
      ...active.filter((entry) => entry.role === "system"),
      ...active.filter((entry) => entry.role !== "system"),
    ];
    const projected = projectMessagesForProvider(current, provider, projection);
    const projectionChanged = projected.length !== current.length || projected.some((message, index) => message !== current[index]);
    if (projectionChanged) {
      // Provider continuation handles and observed token baselines describe the
      // exact prior wire projection. Reusing either after image/opaque elision
      // could reintroduce blocked data or corrupt continuation semantics.
      providerState = undefined;
      providerStateMessageId = undefined;
      toolDefinitionFingerprint = undefined;
      usageBaseline = undefined;
    } else if (providerStateMessageId !== undefined && !current.some((entry) => entry.id === providerStateMessageId)) {
      providerState = undefined;
      providerStateMessageId = undefined;
      toolDefinitionFingerprint = undefined;
    }
    const currentUsage = usageBaseline !== undefined &&
      usageBaseline.prefixMessageIds.length <= projected.length &&
      usageBaseline.prefixMessageIds.every((id, index) => projected[index]?.id === id)
      ? usageBaseline
      : undefined;
    return {
      messages: projected,
      ...(providerState === undefined || providerStateMessageId === undefined
        ? {}
        : {
            providerState,
            providerStateMessageId,
            ...(toolDefinitionFingerprint === undefined ? {} : { toolDefinitionFingerprint }),
          }),
      ...(currentUsage === undefined ? {} : { usageBaseline: currentUsage }),
    };
  }
}

export class StoreArtifactWriter implements ArtifactWriter {
  readonly #store: SessionStore;
  readonly #threadId: string;

  constructor(store: SessionStore, threadId: string) {
    this.#store = store;
    this.#threadId = threadId;
  }

  async write(
    name: string,
    mediaType: string,
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<ToolArtifact> {
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > this.#store.maxArtifactBytes) throw new Error(`Artifact ${name} exceeds the configured limit`);
      parts.push(Buffer.from(chunk));
    }
    const record = this.#store.putArtifact({
      threadId: this.#threadId,
      content: Buffer.concat(parts),
      mediaType,
    });
    return {
      id: record.artifactId,
      path: `artifact:${record.artifactId}/${encodeURIComponent(name)}`,
      mediaType: record.mediaType,
      bytes: record.byteLength,
    };
  }
}
