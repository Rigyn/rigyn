import {
  defineRuntimeTool,
  type RuntimeExtensionApi,
} from "rigyn/extensions";
import {
  defineProviderAdapter,
  type ProviderAdapterDefinition,
} from "rigyn/providers";

declare const api: RuntimeExtensionApi;

api.registerTool(defineRuntimeTool<{ text: string }>({
  name: "consumer_typed_tool",
  description: "Public typed tool helper",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string" } },
  },
  async execute(input, context) {
    context.signal.throwIfAborted();
    return { content: input.text, isError: false };
  },
}));

const providerDefinition = {
  id: "consumer-authored-provider",
  models: [{ id: "consumer-model", capabilities: { tools: true } }],
  async *stream(request, signal) {
    signal.throwIfAborted();
    yield { type: "response_start" as const, model: request.model };
  },
} satisfies ProviderAdapterDefinition;

api.registerProvider(defineProviderAdapter(providerDefinition));
