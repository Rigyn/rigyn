import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";

function failed(model: Model<Api>, error: unknown): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
}
function hasResult(source: AsyncIterable<AssistantMessageEvent>): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } { return typeof (source as { result?: unknown }).result === "function"; }
export function lazyStream(model: Model<Api>, setup: () => Promise<AsyncIterable<AssistantMessageEvent>>): AssistantMessageEventStream {
  const output = new AssistantMessageEventStream();
  void setup().then(async (source) => { for await (const event of source) output.push(event); output.end(hasResult(source) ? await source.result() : undefined); }, (error) => { const message = failed(model, error); output.push({ type: "error", reason: "error", error: message }); output.end(message); });
  return output;
}
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
  return {
    stream: (model, context, options) => lazyStream(model, async () => (await load()).stream(model, context, options)),
    streamSimple: (model, context, options) => lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
  };
}
