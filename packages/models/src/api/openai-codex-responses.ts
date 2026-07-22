import type { SimpleStreamOptions, StreamFunction } from "../types.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import { uuidv7 } from "../utils/uuid.js";
import { streamTask } from "./internal/message-stream.js";
import {
  closeCodexWebSocketSessions, codexWebSocketFallbackActive, codexWebSocketHeaders, codexWebSocketResponse,
  getCodexWebSocketDebugStats, recordCodexSseFallback, recordCodexWebSocketFailure, resetCodexWebSocketDebugStats,
} from "./internal/codex-websocket.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import { executeResponses, type ResponsesOptions, type ResponsesTransport } from "./openai-responses-shared.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";

export interface OpenAICodexResponsesOptions extends ResponsesOptions {
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  textVerbosity?: "low" | "medium" | "high";
  toolChoice?: "auto" | "none" | "required";
}
export interface OpenAICodexWebSocketDebugStats {
  requests: number; connectionsCreated: number; connectionsReused: number; cachedContextRequests: number;
  storeTrueRequests: number; fullContextRequests: number; deltaRequests: number; lastInputItems: number;
  lastDeltaInputItems?: number; lastPreviousResponseId?: string; websocketFailures: number; sseFallbacks: number;
  websocketFallbackActive?: boolean; lastWebSocketError?: string;
}
export const getOpenAICodexWebSocketDebugStats = getCodexWebSocketDebugStats;
export const resetOpenAICodexWebSocketDebugStats = resetCodexWebSocketDebugStats;
export const closeOpenAICodexWebSocketSessions = closeCodexWebSocketSessions;
registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

function endpoint(baseUrl: string): string { const base = baseUrl.replace(/\/+$/u, ""); return /\/codex\/responses$/u.test(base) ? base : `${base}/codex/responses`; }
function tokenAccountId(token: string): string | undefined {
  try { const payload = token.split(".")[1]; if (!payload) return undefined; const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>; const auth = json["https://api.openai.com/auth"] as Record<string, unknown> | undefined; return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined; } catch { return undefined; }
}
const transport: ResponsesTransport<OpenAICodexResponsesOptions> = {
  endpoint(model) { return endpoint(model.baseUrl); },
  headers(model, options) {
    const headers = new Headers(model.headers);
    if (options?.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${options.apiKey}`);
    const account = headers.get("chatgpt-account-id") ?? (options?.apiKey ? tokenAccountId(options.apiKey) : undefined);
    if (account) headers.set("chatgpt-account-id", account);
    headers.set("originator", "rigyn"); headers.set("openai-beta", "responses=experimental");
    const session = clampOpenAIPromptCacheKey(options?.sessionId); if (session) { headers.set("session-id", session); headers.set("x-client-request-id", session); }
    return headers;
  },
  modifyBody(body) { body.store = false; },
};

export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (model, context, options) => {
  const selected = options?.transport ?? "auto";
  const session = clampOpenAIPromptCacheKey(options?.sessionId);
  const useWebSocket = options?.fetch === undefined && selected !== "sse" && !codexWebSocketFallbackActive(session);
  if (selected !== "sse" && !useWebSocket && codexWebSocketFallbackActive(session)) recordCodexSseFallback(session);
  const requestId = session ?? uuidv7();
  const prepared: OpenAICodexResponsesOptions = {
    ...options,
    maxRetries: options?.maxRetries ?? 0,
    ...(useWebSocket ? { fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      try {
        if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
        const headers = codexWebSocketHeaders(model.headers, options.headers, options.apiKey, requestId);
        const account = new Headers(init?.headers).get("chatgpt-account-id") ?? tokenAccountId(options.apiKey);
        if (account) headers.set("chatgpt-account-id", account);
        return await codexWebSocketResponse({ url, headers, body: typeof init?.body === "string" ? init.body : String(init?.body ?? "{}"), options: prepared });
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        recordCodexWebSocketFailure(session, error); recordCodexSseFallback(session);
        return fetch(input, init);
      }
    } } : {}),
  };
  return streamTask(model, (builder) => executeResponses(builder, model, context, prepared, transport), options?.signal);
};

export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (model, context, options) => {
  const reasoning = resolveSimpleReasoning(model, options?.reasoning);
  return stream(model, context, { ...buildBaseOptions(model, context, options), ...(reasoning === undefined ? {} : { reasoningEffort: reasoning }) });
};
