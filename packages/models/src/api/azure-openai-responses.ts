import type { SimpleStreamOptions, StreamFunction } from "../types.js";
import { streamTask } from "./internal/message-stream.js";
import { executeResponses, type ResponsesOptions, type ResponsesTransport } from "./openai-responses-shared.js";
import { buildBaseOptions, resolveSimpleReasoning } from "./simple-options.js";

export interface AzureOpenAIResponsesOptions extends ResponsesOptions { reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; reasoningSummary?: "auto" | "detailed" | "concise" | null; azureApiVersion?: string; azureResourceName?: string; azureBaseUrl?: string; azureDeploymentName?: string; }
const transport: ResponsesTransport<AzureOpenAIResponsesOptions> = {
  endpoint(model, options) {
    const version = options?.azureApiVersion ?? "2025-04-01-preview"; const deployment = options?.azureDeploymentName ?? model.id;
    const base = options?.azureBaseUrl ?? (options?.azureResourceName ? `https://${options.azureResourceName}.openai.azure.com` : model.baseUrl);
    return `${base.replace(/\/+$/u, "")}/openai/deployments/${encodeURIComponent(deployment)}/responses?api-version=${encodeURIComponent(version)}`;
  },
  headers(model, options) { const headers = new Headers(model.headers); if (options?.apiKey && !headers.has("api-key")) headers.set("api-key", options.apiKey); return headers; },
};
export const stream: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (model, context, options) => streamTask(model, (builder) => executeResponses(builder, model, context, options, transport), options?.signal);
export const streamSimple: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (model, context, options) => { const reasoning = resolveSimpleReasoning(model, options?.reasoning); return stream(model, context, { ...buildBaseOptions(model, context, options), ...(reasoning === undefined ? {} : { reasoningEffort: reasoning }) }); };
