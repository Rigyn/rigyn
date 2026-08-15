import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createOpenRouterAuthorization, exchangeOpenRouterCode } from "./openrouter.js";
import { oauthErrorCode } from "./oauth-token.js";

export interface OpenRouterLoopbackSession {
  authorizationUrl: URL;
  waitForKey(): Promise<string>;
  cancel(reason?: Error): void;
}

export async function createOpenRouterLoopback(options: {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
} = {}): Promise<OpenRouterLoopbackSession> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60_000) {
    throw new TypeError("OpenRouter authorization timeout must be between 1 ms and 30 minutes");
  }
  const path = `/oauth/${randomBytes(24).toString("base64url")}`;
  const controller = new AbortController();
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, options.signal]);
  let settle: ((key: string) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  let verifier = "";
  let done = false;
  let exchangeStarted = false;
  let timeout: NodeJS.Timeout | undefined;
  const result = new Promise<string>((resolve, rejectResult) => {
    settle = resolve;
    reject = rejectResult;
  });
  void result.catch(() => undefined);
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url === undefined) {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== path) {
      response.writeHead(404).end();
      return;
    }
    const providerError = url.searchParams.get("error");
    if (providerError !== null) {
      response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("Authorization was not completed.");
      finishFailure(new Error(`OpenRouter authorization failed: ${oauthErrorCode(providerError, "authorization_failed")}`));
      return;
    }
    const code = url.searchParams.get("code");
    if (
      code === null ||
      code === "" ||
      Buffer.byteLength(code, "utf8") > 4096 ||
      /[\x00-\x1f\x7f]/u.test(code)
    ) {
      response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("Authorization code was missing.");
      return;
    }
    if (exchangeStarted) {
      response.writeHead(409, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("Authorization is already being completed.");
      return;
    }
    exchangeStarted = true;
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("Authorization received. You can close this window while sign-in completes.");
    void exchangeOpenRouterCode({
      code,
      verifier,
      signal,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
    }).then(finishSuccess, finishFailure);
  });
  const aborted = (): void => finishFailure(signal.reason ?? new DOMException("Aborted", "AbortError"));
  const finishSuccess = (key: string): void => {
    if (done) return;
    done = true;
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener("abort", aborted);
    server.close();
    settle?.(key);
  };
  const finishFailure = (error: unknown): void => {
    if (done) return;
    done = true;
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener("abort", aborted);
    server.close();
    reject?.(error);
  };
  server.on("error", finishFailure);
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("OpenRouter loopback did not bind a port");
  const authorization = createOpenRouterAuthorization(`http://127.0.0.1:${address.port}${path}`);
  verifier = authorization.verifier;
  timeout = setTimeout(() => finishFailure(new Error("OpenRouter authorization timed out")), timeoutMs);
  timeout.unref();
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  return {
    authorizationUrl: authorization.authorizationUrl,
    waitForKey: () => result,
    cancel: (reason = new Error("OpenRouter authorization cancelled")) => controller.abort(reason),
  };
}
