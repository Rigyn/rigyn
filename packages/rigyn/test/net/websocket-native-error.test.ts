import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import test from "node:test";

import { createNetworkTransport, type NetworkWebSocket } from "../../src/net/fetch.js";
import {
  consumeWebSocketNativeErrorCode,
  createWebSocketWithNativeErrorCapture,
} from "../../src/net/websocket-native-error.js";

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

async function opened(socket: NetworkWebSocket): Promise<void> {
  if (socket.readyState === 1) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket failed before opening"));
    }, { once: true });
  });
}

async function closed(socket: NetworkWebSocket): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket close timed out")), 5_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve(event.code);
    }, { once: true });
  });
}

test("network WebSocket capture correlates a native TCP reset to only the failed socket", async (t) => {
  const peers = new Map<string, Duplex>();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET") throw error;
    });
    acceptWebSocket(request, socket);
    peers.set(request.url ?? "", socket);
  });
  const port = await listen(server);
  const transport = createNetworkTransport({ environment: {}, closeTimeoutMs: 100 });
  t.after(async () => {
    for (const peer of peers.values()) peer.destroy();
    server.closeAllConnections();
    await close(server);
    await transport.close();
  });

  const failed = transport.openWebSocket?.(`ws://127.0.0.1:${port}/failed`, {});
  const healthy = transport.openWebSocket?.(`ws://127.0.0.1:${port}/healthy`, {});
  assert.ok(failed);
  assert.ok(healthy);
  await Promise.all([opened(failed), opened(healthy)]);

  const failedClose = closed(failed);
  const failedPeer = peers.get("/failed") as Duplex & { resetAndDestroy(): void };
  assert.ok(failedPeer);
  failedPeer.resetAndDestroy();

  assert.equal(await failedClose, 1006);
  assert.equal(consumeWebSocketNativeErrorCode(failed), "ECONNRESET");
  assert.equal(consumeWebSocketNativeErrorCode(failed), undefined, "the captured code must be consumed once");
  assert.equal(consumeWebSocketNativeErrorCode(healthy), undefined, "concurrent sockets must not share errors");
});

test("network WebSocket capture returns no diagnostics for fake and healthy sockets", async (t) => {
  const peers = new Set<Duplex>();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    acceptWebSocket(request, socket);
  });
  const port = await listen(server);
  const transport = createNetworkTransport({ environment: {}, closeTimeoutMs: 100 });
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    server.closeAllConnections();
    await close(server);
    await transport.close();
  });

  const healthy = transport.openWebSocket?.(`ws://127.0.0.1:${port}/healthy`, {});
  assert.ok(healthy);
  await opened(healthy);

  assert.equal(consumeWebSocketNativeErrorCode(healthy), undefined);
  assert.equal(consumeWebSocketNativeErrorCode({}), undefined);
});

test("network WebSocket capture ignores uncorrelated and non-allowlisted diagnostics", async () => {
  const diagnostics = channel("undici:websocket:socket_error");
  const uncorrelated = {};
  diagnostics.publish(Object.assign(new Error("private detail"), { code: "ECONNRESET" }));
  assert.equal(consumeWebSocketNativeErrorCode(uncorrelated), undefined);

  const emittedBeforeBinding = createWebSocketWithNativeErrorCapture(() => {
    diagnostics.publish(Object.assign(new Error("private detail"), { code: "ECONNRESET" }));
    return {};
  });
  assert.equal(consumeWebSocketNativeErrorCode(emittedBeforeBinding), undefined);

  let published: (() => void) | undefined;
  const publication = new Promise<void>((resolve) => { published = resolve; });
  const disallowed = createWebSocketWithNativeErrorCapture(() => {
    queueMicrotask(() => {
      diagnostics.publish(Object.assign(new Error("private detail"), { code: "PRIVATE_SOCKET_DETAIL" }));
      published?.();
    });
    return {};
  });
  await publication;
  assert.equal(consumeWebSocketNativeErrorCode(disallowed), undefined);

  let knownPublished: (() => void) | undefined;
  const knownPublication = new Promise<void>((resolve) => { knownPublished = resolve; });
  const known = createWebSocketWithNativeErrorCapture(() => {
    queueMicrotask(() => {
      diagnostics.publish(Object.assign(new Error("private parser detail"), { code: "UND_ERR_INFO" }));
      knownPublished?.();
    });
    return {};
  });
  await knownPublication;
  assert.equal(consumeWebSocketNativeErrorCode(known), "UND_ERR_INFO");
});
