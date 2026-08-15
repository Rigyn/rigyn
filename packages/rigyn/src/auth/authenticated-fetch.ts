import type { ProviderAuthenticatedRequestPolicy } from "./provider-descriptor.js";
import {
  bufferRequestBody,
  MAX_BUFFERED_REQUEST_BODY_BYTES,
  type BufferedRequestBody,
} from "../net/request-body.js";

const MAX_RESPONSE_BODY_BYTES = 32 * 1024 * 1024;
const FORBIDDEN_CALLER_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
]);

export type ProviderRequestAuthorizer = (request: Request) => Request | Promise<Request>;

function abortSignal(primary: AbortSignal | null, secondary?: AbortSignal): AbortSignal | undefined {
  const signals = [primary, secondary].filter((value): value is AbortSignal => value !== null && value !== undefined);
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function authorizedHeaderNames(policy: ProviderAuthenticatedRequestPolicy): Set<string> {
  const names = new Set(FORBIDDEN_CALLER_HEADERS);
  if (policy.apiKey !== undefined) names.add(policy.apiKey.header.toLowerCase());
  if (policy.bearer !== undefined) names.add(policy.bearer.header.toLowerCase());
  if (policy.awsSigV4 !== undefined) {
    names.add("x-amz-date");
    names.add("x-amz-content-sha256");
    names.add("x-amz-security-token");
  }
  return names;
}

function validateTarget(request: Request, policy: ProviderAuthenticatedRequestPolicy): void {
  const url = new URL(request.url);
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("Authenticated provider request URL must not contain credentials or a fragment");
  }
  if (!policy.origins.includes(url.origin)) {
    throw new Error(`Authenticated provider request origin is not allowed: ${url.origin}`);
  }
}

async function validateRequestBody(request: Request): Promise<BufferedRequestBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BUFFERED_REQUEST_BODY_BYTES)) {
    const error = new Error(`Authenticated provider request body exceeds ${MAX_BUFFERED_REQUEST_BODY_BYTES} bytes`);
    void request.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  return await bufferRequestBody(request, "Authenticated provider request body");
}

function boundedResponse(response: Response): Response {
  if (response.body === null) return response;
  let bytes = 0;
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BODY_BYTES) {
        controller.error(new Error(`Authenticated provider response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(bounded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Make one exact-origin provider request. Credential material remains inside
 * the host-owned authorizer and is never returned to extension code.
 */
export async function authenticatedProviderFetch(
  policy: ProviderAuthenticatedRequestPolicy,
  authorize: ProviderRequestAuthorizer,
  fetchImplementation: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  signal?.throwIfAborted();
  const requestSignal = abortSignal(input instanceof Request ? input.signal : null, signal);
  let request = new Request(input, {
    ...init,
    redirect: "error",
    credentials: "omit",
    ...(requestSignal === undefined ? {} : { signal: requestSignal }),
  });
  validateTarget(request, policy);
  const forbidden = authorizedHeaderNames(policy);
  for (const name of request.headers.keys()) {
    if (forbidden.has(name.toLowerCase())) {
      throw new Error(`Authenticated provider request header is host-owned: ${name.toLowerCase()}`);
    }
  }
  request = (await validateRequestBody(request)).request;
  signal?.throwIfAborted();
  const authorizedRequest = await authorize(request);
  if (!(authorizedRequest instanceof Request)) throw new Error("Provider request authorizer returned an invalid request");
  if (authorizedRequest.url !== request.url || authorizedRequest.method !== request.method) {
    throw new Error("Provider request authorizer changed the request target or method");
  }
  validateTarget(authorizedRequest, policy);
  const validated = await validateRequestBody(authorizedRequest);
  const authorized = validated.request;
  signal?.throwIfAborted();
  const authorizedSignal = abortSignal(authorized.signal, signal);
  const body = authorized.body === null || authorized.method === "GET" || authorized.method === "HEAD"
    ? undefined
    : validated.body;
  const outgoing: RequestInit & { duplex?: "half" } = {
    method: authorized.method,
    headers: authorized.headers,
    redirect: "error",
    credentials: "omit",
    ...(authorizedSignal === undefined ? {} : { signal: authorizedSignal }),
  };
  if (body !== undefined) {
    outgoing.body = body;
    outgoing.duplex = "half";
  }
  const response = await fetchImplementation(authorized.url, outgoing);
  return boundedResponse(response);
}
