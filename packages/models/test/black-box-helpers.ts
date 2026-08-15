import assert from "node:assert/strict";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from "../src/index.ts";

export interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

export function model<TApi extends Api>(api: TApi, overrides: Partial<Model<TApi>> = {}): Model<TApi> {
  return {
    id: "black-box-model",
    name: "Black box model",
    api,
    provider: "black-box",
    baseUrl: "https://provider.example/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 2_048,
    ...overrides,
  };
}

export function userContext(text = "hello"): Context {
  return { messages: [{ role: "user", content: text, timestamp: 1 }] };
}

export function sse(records: readonly unknown[]): Response {
  const body = records.map((record) => {
    if (typeof record === "string") return `data: ${record}\n\n`;
    return `data: ${JSON.stringify(record)}\n\n`;
  }).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function eventSse(records: readonly { event: string; data: unknown }[]): Response {
  const body = records.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function captureFetch(response: () => Response): {
  requests: CapturedRequest[];
  fetch: typeof globalThis.fetch;
} {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const body = init.body;
    assert.ok(typeof body === "string");
    requests.push({
      url: String(input),
      init,
      body: JSON.parse(body) as Record<string, unknown>,
    });
    return response();
  };
  return { requests, fetch };
}

export async function collect(stream: AssistantMessageEventStream): Promise<{
  events: AssistantMessageEvent[];
  terminal: Awaited<ReturnType<AssistantMessageEventStream["result"]>>;
}> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const terminal = await stream.result();
  assert.ok(events.at(-1)?.type === "done" || events.at(-1)?.type === "error");
  return { events, terminal };
}
