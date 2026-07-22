import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Context,
  type Model,
  parseStreamingJson,
  type SimpleStreamOptions,
  type StopReason,
  type ToolCall,
} from "@rigyn/models";

type ProxyProviderState = { source: { api: Model["api"]; provider: Model["provider"]; model: string }; value: unknown };
type ProxyAssistantMessage = AssistantMessage & { providerState?: ProxyProviderState };
type ProxyTerminalMetadata = Pick<ProxyAssistantMessage, "responseId" | "responseModel" | "diagnostics" | "providerState">;

export type ProxyAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; contentSignature?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | ({ type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; usage: AssistantMessage["usage"] } & ProxyTerminalMetadata)
  | ({ type: "error"; reason: Extract<StopReason, "aborted" | "error">; errorMessage?: string; usage: AssistantMessage["usage"] } & ProxyTerminalMetadata);

type ProxySerializableStreamOptions = Pick<
  SimpleStreamOptions,
  "temperature" | "maxTokens" | "reasoning" | "cacheRetention" | "sessionId" | "headers" | "metadata" | "transport" | "thinkingBudgets" | "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
  signal?: AbortSignal;
  authToken: string;
  proxyUrl: string;
}

function serializableOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
  return {
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }),
    ...(options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: options.maxRetryDelayMs }),
  };
}

function initialMessage(model: Model): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function snapshot(message: AssistantMessage): AssistantMessage {
  return structuredClone(message);
}

function applyTerminalMetadata(event: ProxyTerminalMetadata, partial: ProxyAssistantMessage): void {
  for (const key of ["responseId", "responseModel", "diagnostics", "providerState"] as const) {
    if (event[key] === undefined) delete partial[key];
    else partial[key] = event[key] as never;
  }
}

function contextForProxy(model: Model, context: Context): Context {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role !== "assistant") return message;
    const assistant = message as ProxyAssistantMessage;
    if (assistant.providerState === undefined) return message;
    const source = assistant.providerState.source;
    if (source.api === model.api && source.provider === model.provider && source.model === model.id) return message;
    changed = true;
    const copy = { ...assistant };
    delete copy.providerState;
    return copy;
  });
  return changed ? { ...context, messages } : context;
}

function mapEvent(
  event: ProxyAssistantMessageEvent,
  partial: AssistantMessage,
  toolJson: Map<number, string>,
): AssistantMessageEvent {
  switch (event.type) {
    case "start":
      return { type: "start", partial: snapshot(partial) };
    case "text_start":
      partial.content[event.contentIndex] = { type: "text", text: "" };
      return { type: "text_start", partial: snapshot(partial), contentIndex: event.contentIndex };
    case "text_delta": {
      const part = partial.content[event.contentIndex];
      if (part?.type !== "text") throw new Error("Received text_delta for non-text content");
      part.text += event.delta;
      return { type: "text_delta", partial: snapshot(partial), contentIndex: event.contentIndex, delta: event.delta };
    }
    case "text_end": {
      const part = partial.content[event.contentIndex];
      if (part?.type !== "text") throw new Error("Received text_end for non-text content");
      if (event.contentSignature === undefined) delete part.textSignature;
      else part.textSignature = event.contentSignature;
      return { type: "text_end", partial: snapshot(partial), contentIndex: event.contentIndex, content: part.text };
    }
    case "thinking_start":
      partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
      return { type: "thinking_start", partial: snapshot(partial), contentIndex: event.contentIndex };
    case "thinking_delta": {
      const part = partial.content[event.contentIndex];
      if (part?.type !== "thinking") throw new Error("Received thinking_delta for non-thinking content");
      part.thinking += event.delta;
      return { type: "thinking_delta", partial: snapshot(partial), contentIndex: event.contentIndex, delta: event.delta };
    }
    case "thinking_end": {
      const part = partial.content[event.contentIndex];
      if (part?.type !== "thinking") throw new Error("Received thinking_end for non-thinking content");
      if (event.contentSignature === undefined) delete part.thinkingSignature;
      else part.thinkingSignature = event.contentSignature;
      return { type: "thinking_end", partial: snapshot(partial), contentIndex: event.contentIndex, content: part.thinking };
    }
    case "toolcall_start":
      partial.content[event.contentIndex] = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
      toolJson.set(event.contentIndex, "");
      return { type: "toolcall_start", partial: snapshot(partial), contentIndex: event.contentIndex };
    case "toolcall_delta": {
      const part = partial.content[event.contentIndex];
      if (part?.type !== "toolCall") throw new Error("Received toolcall_delta for non-tool content");
      const json = (toolJson.get(event.contentIndex) ?? "") + event.delta;
      toolJson.set(event.contentIndex, json);
      part.arguments = parseStreamingJson(json);
      return { type: "toolcall_delta", partial: snapshot(partial), contentIndex: event.contentIndex, delta: event.delta };
    }
    case "toolcall_end": {
      const part = partial.content[event.contentIndex];
      if (part?.type !== "toolCall") throw new Error("Received toolcall_end for non-tool content");
      part.arguments = parseStreamingJson(toolJson.get(event.contentIndex));
      return { type: "toolcall_end", partial: snapshot(partial), contentIndex: event.contentIndex, toolCall: structuredClone(part) satisfies ToolCall };
    }
    case "done":
      applyTerminalMetadata(event, partial);
      partial.stopReason = event.reason;
      partial.usage = event.usage;
      return { type: "done", reason: event.reason, message: snapshot(partial) };
    case "error":
      applyTerminalMetadata(event, partial);
      partial.stopReason = event.reason;
      partial.usage = event.usage;
      if (event.errorMessage === undefined) delete partial.errorMessage;
      else partial.errorMessage = event.errorMessage;
      return { type: "error", reason: event.reason, error: snapshot(partial) };
  }
}

function eventData(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  const data = line.slice(5).trimStart().trim();
  return data || undefined;
}

export function streamProxy(model: Model, context: Context, options: ProxyStreamOptions) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const partial = initialMessage(model);
    const toolJson = new Map<number, string>();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let terminal = false;
    const abort = () => { void reader?.cancel("Proxy request aborted").catch(() => undefined); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(`${options.proxyUrl}/api/stream`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, context: contextForProxy(model, context), options: serializableOptions(options) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!response.ok) {
        let message = `Proxy error: ${response.status} ${response.statusText}`;
        try {
          const body = await response.json() as { error?: unknown };
          if (typeof body.error === "string" && body.error) message = `Proxy error: ${body.error}`;
        } catch {
          // Preserve the status error when the response is not JSON.
        }
        throw new Error(message);
      }
      if (!response.body) throw new Error("Proxy response body is missing");

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consume = (line: string) => {
        const data = eventData(line.replace(/\r$/u, ""));
        if (!data || data === "[DONE]") return;
        const mapped = mapEvent(JSON.parse(data) as ProxyAssistantMessageEvent, partial, toolJson);
        if (mapped.type === "done" || mapped.type === "error") terminal = true;
        stream.push(mapped);
      };

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (options.signal?.aborted) throw new Error("Proxy request aborted");
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consume(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      if (options.signal?.aborted) throw new Error("Proxy request aborted");
      if (!terminal) throw new Error("Proxy stream ended before a terminal event");
    } catch (error) {
      if (!terminal) {
        partial.stopReason = options.signal?.aborted ? "aborted" : "error";
        partial.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: partial.stopReason, error: snapshot(partial) });
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      stream.end();
    }
  })();
  return stream;
}
