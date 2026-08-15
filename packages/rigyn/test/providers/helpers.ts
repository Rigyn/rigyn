import type { AdapterEvent, ProviderRequest } from "../../src/core/types.js";

export function byteChunks(value: string | Uint8Array, sizes: number[] = []): Uint8Array[] {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (sizes.length === 0) return [...bytes].map((byte) => Uint8Array.of(byte));
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    chunks.push(bytes.slice(offset, Math.min(bytes.length, offset + size)));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset));
  return chunks;
}

export function readable(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export function streamResponse(
  chunks: Uint8Array[],
  headers: HeadersInit = { "content-type": "text/event-stream" },
  status = 200,
): Response {
  return new Response(readable(chunks), { status, headers });
}

export function fakeFetch(factory: (request: Request) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    return await factory(request);
  }) as typeof fetch;
}

export async function collect(iterable: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

export function request(provider: ProviderRequest["provider"]): ProviderRequest {
  return {
    provider,
    model: "test-model",
    messages: [
      {
        id: "message-1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ],
    tools: [],
  };
}

export function terminalCount(events: AdapterEvent[]): number {
  return events.filter((event) => event.type === "response_end" || event.type === "error").length;
}
