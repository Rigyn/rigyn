import type { OpenAICodexResponsesOptions, OpenAICodexWebSocketDebugStats } from "../openai-codex-responses.js";
import type { ProviderHeaders } from "../../types.js";

type Listener = (event: unknown) => void;
interface SocketLike {
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void;
  removeEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void;
}
type SocketConstructor = new (url: string, protocols?: string | string[] | { headers?: Record<string, string> }) => SocketLike;
interface Continuation { request: Record<string, unknown>; responseId: string; responseItems: unknown[]; }
interface CachedSocket { socket: SocketLike; busy: boolean; createdAt: number; idleTimer?: ReturnType<typeof setTimeout>; continuation?: Continuation; }

const IDLE_TTL = 5 * 60_000;
const MAX_AGE = 55 * 60_000;
const sockets = new Map<string, CachedSocket>();
const stats = new Map<string, OpenAICodexWebSocketDebugStats>();
const fallback = new Set<string>();

function initialStats(): OpenAICodexWebSocketDebugStats {
  return { requests: 0, connectionsCreated: 0, connectionsReused: 0, cachedContextRequests: 0, storeTrueRequests: 0, fullContextRequests: 0, deltaRequests: 0, lastInputItems: 0, websocketFailures: 0, sseFallbacks: 0 };
}
function debug(sessionId: string): OpenAICodexWebSocketDebugStats { const value = stats.get(sessionId) ?? initialStats(); stats.set(sessionId, value); return value; }
export function getCodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined { const value = stats.get(sessionId); return value ? { ...value } : undefined; }
export function resetCodexWebSocketDebugStats(sessionId?: string): void { if (sessionId) { stats.delete(sessionId); fallback.delete(sessionId); } else { stats.clear(); fallback.clear(); } }
function close(socket: SocketLike, reason: string): void { try { socket.close(1000, reason); } catch { /* already closed */ } }
export function closeCodexWebSocketSessions(sessionId?: string): void {
  const closeEntry = (entry: CachedSocket) => { if (entry.idleTimer) clearTimeout(entry.idleTimer); close(entry.socket, "session_cleanup"); };
  if (sessionId) { const entry = sockets.get(sessionId); if (entry) closeEntry(entry); sockets.delete(sessionId); return; }
  for (const entry of sockets.values()) closeEntry(entry); sockets.clear();
}
export function codexWebSocketFallbackActive(sessionId?: string): boolean { return sessionId ? fallback.has(sessionId) : false; }
export function recordCodexSseFallback(sessionId?: string): void { if (!sessionId) return; const value = debug(sessionId); value.sseFallbacks += 1; value.websocketFallbackActive = fallback.has(sessionId); }
export function recordCodexWebSocketFailure(sessionId: string | undefined, error: unknown): void { if (!sessionId) return; fallback.add(sessionId); const value = debug(sessionId); value.websocketFailures += 1; value.lastWebSocketError = error instanceof Error ? error.message : String(error); value.websocketFallbackActive = true; }

function ready(socket: SocketLike): boolean { return socket.readyState === undefined || socket.readyState === 1; }
function schedule(sessionId: string, entry: CachedSocket): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => { if (!entry.busy && sockets.get(sessionId) === entry) { close(entry.socket, "idle_timeout"); sockets.delete(sessionId); } }, IDLE_TTL);
  entry.idleTimer.unref?.();
}
function constructor(): SocketConstructor | undefined { const value = (globalThis as { WebSocket?: unknown }).WebSocket; return typeof value === "function" ? value as SocketConstructor : undefined; }
async function connect(url: string, headers: Headers, signal?: AbortSignal, timeoutMs = 15_000): Promise<SocketLike> {
  const Socket = constructor();
  if (!Socket) throw new Error("WebSocket transport is unavailable in this runtime");
  const values = Object.fromEntries(headers.entries());
  return new Promise<SocketLike>((resolve, reject) => {
    let socket: SocketLike;
    try { socket = new Socket(url, { headers: values }); } catch (error) { reject(error); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); socket.removeEventListener("open", opened); socket.removeEventListener("error", failed); socket.removeEventListener("close", failed); signal?.removeEventListener("abort", aborted); };
    const opened = () => { cleanup(); resolve(socket); };
    const failed = (event: unknown) => { cleanup(); close(socket, "connect_failed"); reject(new Error(typeof (event as { message?: unknown })?.message === "string" ? String((event as { message: string }).message) : "WebSocket connection failed")); };
    const aborted = () => { cleanup(); close(socket, "aborted"); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    socket.addEventListener("open", opened); socket.addEventListener("error", failed); socket.addEventListener("close", failed); signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    else if (timeoutMs > 0) { timer = setTimeout(() => { cleanup(); close(socket, "connect_timeout"); reject(new Error(`WebSocket connect timeout after ${timeoutMs}ms`)); }, timeoutMs); timer.unref?.(); }
  });
}

async function acquire(url: string, headers: Headers, sessionId: string | undefined, options: OpenAICodexResponsesOptions): Promise<{ socket: SocketLike; entry?: CachedSocket; reused: boolean; release(keep: boolean): void }> {
  if (sessionId) {
    const cached = sockets.get(sessionId);
    if (cached?.idleTimer) { clearTimeout(cached.idleTimer); delete cached.idleTimer; }
    if (cached && !cached.busy && ready(cached.socket) && Date.now() - cached.createdAt < MAX_AGE) {
      cached.busy = true;
      return { socket: cached.socket, entry: cached, reused: true, release(keep) { if (!keep || !ready(cached.socket)) { close(cached.socket, "done"); sockets.delete(sessionId); return; } cached.busy = false; schedule(sessionId, cached); } };
    }
    if (cached && !cached.busy) { close(cached.socket, "expired"); sockets.delete(sessionId); }
  }
  const socket = await connect(url, headers, options.signal, options.websocketConnectTimeoutMs);
  if (!sessionId || sockets.get(sessionId)?.busy) return { socket, reused: false, release() { close(socket, "done"); } };
  const entry: CachedSocket = { socket, busy: true, createdAt: Date.now() }; sockets.set(sessionId, entry);
  return { socket, entry, reused: false, release(keep) { if (!keep || !ready(socket)) { close(socket, "done"); if (sockets.get(sessionId) === entry) sockets.delete(sessionId); return; } entry.busy = false; schedule(sessionId, entry); } };
}

function sameExceptInput(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const without = (value: Record<string, unknown>) => { const { input: _input, previous_response_id: _previous, ...rest } = value; return rest; };
  return JSON.stringify(without(left)) === JSON.stringify(without(right));
}
function cachedBody(entry: CachedSocket, body: Record<string, unknown>): Record<string, unknown> {
  const previous = entry.continuation; if (!previous || !sameExceptInput(body, previous.request)) return body;
  const input = Array.isArray(body.input) ? body.input : []; const oldInput = Array.isArray(previous.request.input) ? previous.request.input : [];
  const baseline = [...oldInput, ...previous.responseItems];
  if (input.length < baseline.length || JSON.stringify(input.slice(0, baseline.length)) !== JSON.stringify(baseline)) { delete entry.continuation; return body; }
  return { ...body, previous_response_id: previous.responseId, input: input.slice(baseline.length) };
}
async function dataText(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data === "object" && typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function") return new TextDecoder().decode(await (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
  return undefined;
}

export async function codexWebSocketResponse(input: { url: string; headers: Headers; body: string; options: OpenAICodexResponsesOptions }): Promise<Response> {
  const wsUrl = input.url.replace(/^https:/u, "wss:").replace(/^http:/u, "ws:");
  const sessionId = input.options.sessionId;
  const acquired = await acquire(wsUrl, input.headers, sessionId, input.options);
  const fullBody = JSON.parse(input.body) as Record<string, unknown>;
  const useCache = input.options.transport === "auto" || input.options.transport === "websocket-cached";
  const request = useCache && acquired.entry ? cachedBody(acquired.entry, fullBody) : fullBody;
  if (sessionId) {
    const value = debug(sessionId); value.requests += 1; if (acquired.reused) value.connectionsReused += 1; else value.connectionsCreated += 1;
    if (useCache) value.cachedContextRequests += 1; if (request.store === true) value.storeTrueRequests += 1;
    value.lastInputItems = Array.isArray(request.input) ? request.input.length : 0;
    if (typeof request.previous_response_id === "string") { value.deltaRequests += 1; value.lastDeltaInputItems = value.lastInputItems; value.lastPreviousResponseId = request.previous_response_id; }
    else { value.fullContextRequests += 1; delete value.lastDeltaInputItems; delete value.lastPreviousResponseId; }
  }
  let terminal = false; let released = false;
  const release = (keep: boolean) => { if (released) return; released = true; acquired.release(keep); };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { if (timer) clearTimeout(timer); acquired.socket.removeEventListener("message", message); acquired.socket.removeEventListener("error", failed); acquired.socket.removeEventListener("close", closed); input.options.signal?.removeEventListener("abort", aborted); };
      const finish = (keep: boolean) => { cleanup(); release(keep); try { controller.close(); } catch { /* already closed */ } };
      const message = (event: unknown) => { void (async () => {
        try {
          const text = await dataText((event as { data?: unknown })?.data); if (!text) return;
          const parsed = JSON.parse(text) as Record<string, unknown>; const type = typeof parsed.type === "string" ? parsed.type : "";
          controller.enqueue(encoder.encode(`data: ${text}\n\n`));
          if (type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error") {
            terminal = true;
            const response = parsed.response as Record<string, unknown> | undefined;
            if (useCache && acquired.entry && type === "response.completed" && typeof response?.id === "string") acquired.entry.continuation = { request: fullBody, responseId: response.id, responseItems: Array.isArray(response.output) ? response.output : [] };
            finish(type === "response.completed" || type === "response.incomplete");
          }
        } catch (error) { cleanup(); release(false); controller.error(error); }
      })(); };
      const failed = (event: unknown) => { cleanup(); release(false); controller.error(new Error(typeof (event as { message?: unknown })?.message === "string" ? String((event as { message: string }).message) : "WebSocket stream failed")); };
      const closed = () => { if (terminal) return; cleanup(); release(false); controller.error(new Error("WebSocket stream closed before a terminal response event")); };
      const aborted = () => { cleanup(); release(false); controller.error(input.options.signal?.reason ?? new DOMException("Aborted", "AbortError")); };
      acquired.socket.addEventListener("message", message); acquired.socket.addEventListener("error", failed); acquired.socket.addEventListener("close", closed); input.options.signal?.addEventListener("abort", aborted, { once: true });
      const timeout = input.options.timeoutMs; if (timeout !== undefined && timeout > 0) { timer = setTimeout(() => { cleanup(); release(false); controller.error(new Error(`WebSocket idle timeout after ${timeout}ms`)); }, timeout); timer.unref?.(); }
      acquired.socket.send(JSON.stringify({ type: "response.create", ...request }));
    },
    cancel() { release(false); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-rigyn-transport": "websocket" } });
}

export function codexWebSocketHeaders(modelHeaders: Record<string, string> | undefined, optionHeaders: ProviderHeaders | undefined, token: string, sessionId: string): Headers {
  const headers = new Headers(modelHeaders);
  for (const [name, value] of Object.entries(optionHeaders ?? {})) value === null ? headers.delete(name) : headers.set(name, value);
  headers.set("authorization", `Bearer ${token}`); headers.set("originator", "rigyn"); headers.set("openai-beta", "responses_websockets=2026-02-06"); headers.set("x-client-request-id", sessionId); headers.set("session-id", sessionId);
  return headers;
}
