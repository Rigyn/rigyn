import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import test from "node:test";

import { createNetworkTransport } from "../../src/net/fetch.js";
import {
  OPENAI_CODEX_TRANSPORT_OBSERVER,
  type OpenAICodexObservabilityOptions,
  type OpenAICodexTransportObservation,
} from "../../src/providers/openai-codex-observability.js";
import {
  OpenAICodexResponsesAdapter,
  type OpenAICodexResponsesConfig,
} from "../../src/providers/openai-codex-responses.js";
import { collect, request } from "./helpers.js";

async function listen(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("server did not expose a port"));
      else resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function acceptWebSocket(request: IncomingMessage, socket: Duplex): void {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
}

function webSocketTextFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.byteLength <= 125) return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.byteLength, 2);
  return Buffer.concat([header, payload]);
}

test("Codex adapter preserves the allowlisted native reset code without raw socket details", async (t) => {
  const server = createServer();
  server.on("upgrade", (incoming, socket) => {
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") throw error;
    });
    acceptWebSocket(incoming, socket);
    socket.once("data", () => (socket as Duplex & { resetAndDestroy(): void }).resetAndDestroy());
  });
  const port = await listen(server);
  const transport = createNetworkTransport({ environment: {}, closeTimeoutMs: 100 });
  t.after(async () => {
    server.closeAllConnections();
    await close(server);
    await transport.close();
  });

  const observations: OpenAICodexTransportObservation[] = [];
  const config: OpenAICodexResponsesConfig & OpenAICodexObservabilityOptions = {
    baseUrl: `http://127.0.0.1:${port}`,
    credential: async () => ({ accessToken: "fixture-access", accountId: "fixture-account" }),
    transport: "websocket",
    webSocket: transport.openWebSocket!,
    [OPENAI_CODEX_TRANSPORT_OBSERVER]: (observation) => observations.push(observation),
  };
  const adapter = new OpenAICodexResponsesAdapter(config);
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  const terminal = events.at(-1);

  assert.equal(terminal?.type, "error");
  assert.equal(terminal?.type === "error" ? terminal.error.providerCode : undefined, "ECONNRESET");
  assert.deepEqual(observations.at(-1), {
    type: "websocket_failed",
    failureClass: "close",
    closeCode: 1006,
    transportCode: "ECONNRESET",
    partialOutput: false,
  });
  assert.doesNotMatch(JSON.stringify(events), /fixture-access|fixture-account|127\.0\.0\.1/u);
});

test("an unsuccessful SSE auth fallback does not pin the recovered Codex identity", async (t) => {
  let recovered = false;
  let upgradeRequests = 0;
  let httpRequests = 0;
  const peers = new Set<Duplex>();
  const server = createServer((_request, response) => {
    httpRequests += 1;
    if (!recovered) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      type: "response.completed",
      response: { id: "unexpected-sse", model: "gpt-5.5", output: [], usage: {} },
    })}\n\n`);
  });
  server.on("upgrade", (incoming, socket) => {
    upgradeRequests += 1;
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.on("error", () => undefined);
    if (!recovered) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    acceptWebSocket(incoming, socket);
    socket.once("data", () => socket.write(Buffer.concat([
      webSocketTextFrame({ type: "response.created", response: { id: "recovered-ws", model: "gpt-5.5" } }),
      webSocketTextFrame({
        type: "response.completed",
        response: { id: "recovered-ws", model: "gpt-5.5", output: [], usage: {} },
      }),
    ])));
  });
  const port = await listen(server);
  const transport = createNetworkTransport({ environment: {}, closeTimeoutMs: 100 });
  const adapter = new OpenAICodexResponsesAdapter({
    baseUrl: `http://127.0.0.1:${port}`,
    credential: async () => ({ accessToken: "fixture-access", accountId: "fixture-account" }),
    transport: "auto",
    fetch: transport.fetch,
    webSocket: transport.openWebSocket!,
  });
  t.after(async () => {
    adapter.dispose();
    for (const peer of peers) peer.destroy();
    server.closeAllConnections();
    await close(server);
    await transport.close();
  });

  const input = request("openai-codex");
  input.sessionId = "auth-recovery";
  const first = await collect(adapter.stream(input, new AbortController().signal));
  assert.equal(first.at(-1)?.type, "error");
  const failedUpgradeRequests = upgradeRequests;

  recovered = true;
  const second = await collect(adapter.stream(input, new AbortController().signal));
  assert.equal(second.at(-1)?.type, "response_end");
  assert.equal(upgradeRequests, failedUpgradeRequests + 1);
  assert.equal(httpRequests, 1);
  assert.doesNotMatch(JSON.stringify([...first, ...second]), /fixture-access|fixture-account|127\.0\.0\.1/u);
});
