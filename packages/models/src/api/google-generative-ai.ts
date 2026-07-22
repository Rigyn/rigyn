import type { SimpleStreamOptions, StreamFunction } from "../types.js";
import { streamTask } from "./internal/message-stream.js";
import { executeGoogle, type GoogleRuntimeOptions, type GoogleTransport } from "./google-runtime.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";
export interface GoogleOptions extends GoogleRuntimeOptions {}
const transport: GoogleTransport<GoogleOptions> = { endpoint(model, options) { const base = model.baseUrl.replace(/\/+$/u, ""); const key = options?.apiKey ? `&key=${encodeURIComponent(options.apiKey)}` : ""; return `${base}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse${key}`; }, headers(model) { return new Headers(model.headers); } };
export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (model, context, options) => streamTask(model, (builder) => executeGoogle(builder, model, context, options, transport), options?.signal);
export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (model, context, options) => { const reasoning = resolveSimpleReasoning(model, options?.reasoning); const levels = { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "HIGH", max: "HIGH" } as const; return stream(model, context, { ...buildBaseOptions(model, context, options), thinking: { enabled: reasoning !== undefined, ...(reasoning === undefined ? {} : { level: levels[reasoning], budgetTokens: options?.thinkingBudgets?.[reasoning] ?? -1 }) } }); };
