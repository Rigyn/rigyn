import type { Context, OpenAIResponsesCompat, SimpleStreamOptions, StreamFunction } from "../types.js";
import { buildCopilotDynamicHeaders } from "./github-copilot-headers.js";
import { streamTask } from "./internal/message-stream.js";
import { executeResponses, type ResponsesOptions, type ResponsesTransport } from "./openai-responses-shared.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";

export interface OpenAIResponsesOptions extends ResponsesOptions { reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; reasoningSummary?: "auto" | "detailed" | "concise" | null; }
const transport: ResponsesTransport<OpenAIResponsesOptions> = {
  endpoint(model) { const base = model.baseUrl.replace(/\/+$/u, ""); return /\/responses$/u.test(base) ? base : `${base}/responses`; },
  headers(model, options, context?: Context) {
    const headers = new Headers(model.headers);
    if (model.provider === "github-copilot" && context) {
      for (const [name, value] of Object.entries(buildCopilotDynamicHeaders({ messages: context.messages }))) headers.set(name, value);
    }
    if (options?.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${options.apiKey}`);
    if (options?.sessionId && options.cacheRetention !== "none") {
      const format = (model.compat as OpenAIResponsesCompat | undefined)?.sessionAffinityFormat ?? (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai");
      if (format === "openrouter") headers.set("x-session-id", options.sessionId);
      else {
        if (format === "openai") headers.set("session_id", options.sessionId);
        headers.set("x-client-request-id", options.sessionId);
      }
    }
    return headers;
  },
};
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (model, context, options) => streamTask(model, (builder) => executeResponses(builder, model, context, options, transport), options?.signal);
export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (model, context, options) => { const reasoning = resolveSimpleReasoning(model, options?.reasoning); return stream(model, context, { ...buildBaseOptions(model, context, options), ...(reasoning === undefined ? {} : { reasoningEffort: reasoning }) }); };
