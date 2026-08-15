import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import test from "node:test";
import { brotliCompressSync } from "node:zlib";
import { Agent } from "undici";

import { SecretRedactor } from "../../src/auth/redaction.js";
import { createNetworkTransport } from "../../src/net/fetch.js";

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

const WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1_024 * 1_024;

function webSocketTextFrame(bytes: number): Buffer {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x7f;
  header.writeBigUInt64BE(BigInt(bytes), 2);
  return Buffer.concat([header, Buffer.alloc(bytes, 0x20)]);
}

async function oversizedWebSocketOutcome(
  proxy: boolean,
  simulatedPeerShutdown?: NodeJS.ErrnoException,
): Promise<"close" | "error" | "message"> {
  const sockets = new Set<Duplex>();
  let unexpectedPeerError: unknown;
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") unexpectedPeerError ??= error;
    });
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
    socket.write(webSocketTextFrame(WEBSOCKET_MAX_PAYLOAD_BYTES + 1));
    if (simulatedPeerShutdown !== undefined) socket.emit("error", simulatedPeerShutdown);
  });
  const port = await listen(server);
  const transport = createNetworkTransport({
    environment: {},
    closeTimeoutMs: 100,
    ...(proxy
      ? { proxy: { http: "http://127.0.0.1:9", noProxy: "*" } }
      : {}),
  });
  let socket: ReturnType<NonNullable<typeof transport.openWebSocket>> | undefined;
  try {
    const openedSocket = transport.openWebSocket?.(`ws://127.0.0.1:${port}/payload`, {});
    assert.ok(openedSocket);
    socket = openedSocket;
    return await new Promise<"close" | "error" | "message">((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket payload test timed out")), 10_000);
      const settle = (outcome: "close" | "error" | "message"): void => {
        clearTimeout(timer);
        resolve(outcome);
      };
      openedSocket.addEventListener("close", () => settle("close"), { once: true });
      openedSocket.addEventListener("error", () => settle("error"), { once: true });
      openedSocket.addEventListener("message", () => settle("message"), { once: true });
    });
  } finally {
    socket?.close();
    for (const openSocket of sockets) openSocket.destroy();
    server.closeAllConnections();
    await close(server);
    await transport.close();
    if (unexpectedPeerError !== undefined) throw unexpectedPeerError;
  }
}

test("network transport caps direct and proxy WebSocket dispatcher payloads at 16 MiB", async (t) => {
  for (const proxy of [false, true]) {
    await t.test(proxy ? "proxy dispatcher" : "direct dispatcher", async () => {
      assert.notEqual(await oversizedWebSocketOutcome(proxy), "message");
    });
  }
});

test("oversized WebSocket fixture contains only expected peer shutdown errors", async () => {
  for (const code of ["EPIPE", "ECONNRESET"]) {
    const error = Object.assign(new Error(code), { code });
    assert.notEqual(await oversizedWebSocketOutcome(true, error), "message");
  }
  const unexpected = Object.assign(new Error("unexpected socket failure"), { code: "EINVAL" });
  await assert.rejects(oversizedWebSocketOutcome(true, unexpected), /unexpected socket failure/u);
});

test("network transport routes HTTP through a scoped proxy and honors a host-and-port NO_PROXY entry", async (t) => {
  const target = createServer((_request, response) => response.end("direct"));
  const proxyRequests: string[] = [];
  const proxy = createServer((request, response) => {
    proxyRequests.push(request.url ?? "");
    response.end("proxied");
  });
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await Promise.all([close(target), close(proxy)]);
  });
  const targetUrl = `http://127.0.0.1:${targetPort}/resource`;

  const proxied = createNetworkTransport({
    environment: {},
    proxy: { http: `http://127.0.0.1:${proxyPort}` },
  });
  assert.equal(await (await proxied.fetch(targetUrl)).text(), "proxied");
  assert.deepEqual(proxyRequests, [targetUrl]);
  assert.deepEqual(proxied.info, {
    proxied: true,
    httpProxy: `http://127.0.0.1:${proxyPort}`,
    httpsProxy: `http://127.0.0.1:${proxyPort}`,
    noProxyConfigured: false,
  });
  await proxied.close();

  const bypassed = createNetworkTransport({
    environment: {},
    proxy: {
      http: `http://127.0.0.1:${proxyPort}`,
      noProxy: `127.0.0.1:${targetPort}`,
    },
  });
  assert.equal(await (await bypassed.fetch(targetUrl)).text(), "direct");
  assert.equal(proxyRequests.length, 1);
  await bypassed.close();
});

test("network transport accepts a Node-global Request without losing request init semantics", async (t) => {
  const received: Array<{ method: string; header: string | undefined; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        header: request.headers["x-request-kind"]?.toString(),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(201, { "x-response-kind": "local" });
      response.end("accepted");
    });
  });
  const port = await listen(server);
  t.after(async () => close(server));
  const transport = createNetworkTransport({ environment: {} });
  t.after(async () => transport.close());

  const response = await transport.fetch(new Request(`http://127.0.0.1:${port}/request`, {
    method: "POST",
    headers: { "x-request-kind": "source" },
    body: "request-body",
    redirect: "error",
  }), {
    headers: { "x-request-kind": "override" },
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-response-kind"), "local");
  assert.equal(await response.text(), "accepted");
  assert.deepEqual(received, [{ method: "POST", header: "override", body: "request-body" }]);
});

test("network transport accepts disabled and long idle timeouts and rejects unsafe timer values", async () => {
  const transport = createNetworkTransport({
    environment: {},
    headersTimeoutMs: 1_800_000,
    bodyTimeoutMs: 0,
  });
  await transport.close();
  assert.throws(
    () => createNetworkTransport({ environment: {}, headersTimeoutMs: 2_147_483_648 }),
    /headersTimeoutMs/u,
  );
});

test("network transport decodes compressed JSON with its matching dispatcher implementation", async (t) => {
  const body = brotliCompressSync(Buffer.from(JSON.stringify({ ok: true })));
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "br",
      "content-length": String(body.byteLength),
    });
    response.end(body);
  });
  const port = await listen(server);
  t.after(async () => close(server));
  const transport = createNetworkTransport({ environment: {} });
  t.after(async () => transport.close());

  const response = await transport.fetch(`http://127.0.0.1:${port}/compressed`);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true });
});

test("network transport force-closes responses that outlive the graceful shutdown deadline", async (t) => {
  let heldResponse: ServerResponse | undefined;
  const server = createServer((_request, response) => {
    heldResponse = response;
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("still-open");
  });
  const port = await listen(server);
  t.after(async () => {
    heldResponse?.destroy();
    server.closeAllConnections();
    await close(server);
  });
  const transport = createNetworkTransport({ environment: {}, closeTimeoutMs: 25 });
  const response = await transport.fetch(`http://127.0.0.1:${port}/stream`);
  assert.equal(response.status, 200);

  const startedAt = Date.now();
  await transport.close();
  assert.ok(Date.now() - startedAt < 1_000, "network transport close exceeded its bounded deadline");
});

test("network transport destroys its dispatcher when graceful close rejects", async () => {
  const prototype = Agent.prototype as unknown as {
    close(): Promise<void>;
    destroy(error?: Error): Promise<void>;
  };
  const closeDescriptor = Object.getOwnPropertyDescriptor(prototype, "close");
  const destroyDescriptor = Object.getOwnPropertyDescriptor(prototype, "destroy");
  let destroys = 0;
  prototype.close = async () => { throw new Error("graceful dispatcher close failed"); };
  prototype.destroy = async function (): Promise<void> {
    destroys += 1;
  };
  try {
    const transport = createNetworkTransport({ environment: {} });
    await assert.rejects(transport.close(), /graceful dispatcher close failed/u);
    assert.equal(destroys, 1);
  } finally {
    if (closeDescriptor === undefined) delete (prototype as unknown as Record<string, unknown>).close;
    else Object.defineProperty(prototype, "close", closeDescriptor);
    if (destroyDescriptor === undefined) delete (prototype as unknown as Record<string, unknown>).destroy;
    else Object.defineProperty(prototype, "destroy", destroyDescriptor);
  }
});

test("network transport resolves lowercase variables first, supports ALL_PROXY, and accepts explicit opt-out", async () => {
  const lowercase = createNetworkTransport({
    environment: {
      http_proxy: "http://lower.example:8000",
      HTTP_PROXY: "http://upper.example:9000",
      ALL_PROXY: "https://all.example:9443",
    },
  });
  assert.equal(lowercase.info.httpProxy, "http://lower.example:8000");
  assert.equal(lowercase.info.httpsProxy, "https://all.example:9443");
  await lowercase.close();

  const all = createNetworkTransport({ environment: { ALL_PROXY: "https://all.example:9443" } });
  assert.equal(all.info.httpProxy, "https://all.example:9443");
  assert.equal(all.info.httpsProxy, "https://all.example:9443");
  await all.close();

  const disabled = createNetworkTransport({
    environment: { HTTP_PROXY: "http://environment.example:8080", HTTPS_PROXY: "http://environment.example:8081" },
    proxy: { http: false, https: false },
  });
  assert.deepEqual(disabled.info, { proxied: false, noProxyConfigured: false });
  await disabled.close();
  await assert.rejects(disabled.fetch("http://127.0.0.1/"), /closed/u);
});

test("proxy validation rejects unsupported transports and never exposes credentials in metadata", async () => {
  assert.throws(
    () => createNetworkTransport({ environment: {}, proxy: { all: "socks5://secret.example:1080" } }),
    /SOCKS and PAC/u,
  );
  const redactor = new SecretRedactor();
  const transport = createNetworkTransport({
    environment: {},
    redactor,
    proxy: { https: "http://person:password-secret@proxy.example:8080" },
  });
  assert.deepEqual(transport.info, {
    proxied: true,
    httpsProxy: "http://proxy.example:8080",
    noProxyConfigured: false,
  });
  assert.doesNotMatch(JSON.stringify(transport.info), /person|password-secret/u);
  assert.equal(redactor.redact("password-secret"), "[REDACTED]");
  await transport.close();
});
