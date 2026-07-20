import {
  defineRuntimeTool,
  type ExtensionManifestPermissions,
  type RuntimeAdvancedUiApi,
  type RuntimeExtensionApi,
  type RuntimeTreePreparation,
  type RuntimeTreeResult,
} from "rigyn/extensions";
import {
  defineProviderAdapter,
  defineRoutedProviderAdapter,
  type ProviderAdapterDefinition,
} from "rigyn/providers";

declare const api: RuntimeExtensionApi;

const advancedUiPermission = {
  advancedUi: true,
  nativeUi: false,
  unsafeTerminal: false,
  providerOverride: false,
  providerWire: false,
  credentialAccess: false,
  sessionRaw: false,
  hostConfiguration: false,
} satisfies ExtensionManifestPermissions;
const advancedUiSurfaceMatchesApi: RuntimeExtensionApi["ui"]["advanced"] extends RuntimeAdvancedUiApi ? true : false = true;
void [advancedUiPermission, advancedUiSurfaceMatchesApi];

api.registerEditorRenderer({
  render(view) {
    return {
      lines: [{ spans: [{ text: view.text, role: "editor" }] }],
      cursor: { row: 0, column: view.cursor },
    };
  },
});

api.on("tool_call", (event) => ({ input: event.input }));

api.on("session_before_tree", (event): RuntimeTreeResult | undefined => {
  const preparation: RuntimeTreePreparation = event.preparation;
  event.signal.throwIfAborted();
  if (!preparation.userWantsSummary) return undefined;
  return {
    ...(preparation.customInstructions === undefined ? {} : { customInstructions: preparation.customInstructions }),
    ...(preparation.replaceInstructions === undefined ? {} : { replaceInstructions: preparation.replaceInstructions }),
    ...(preparation.label === undefined ? {} : { label: preparation.label }),
  };
});

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

const authoredProvider = defineProviderAdapter(providerDefinition);
const disposeProvider = api.registerProvider(defineRoutedProviderAdapter({
  id: "consumer-routed-provider",
  delegateOwnership: "owned",
  routes: [{
    model: "consumer-model",
    protocolFamily: "openai-chat-completions",
    adapter: authoredProvider,
  }],
}));
void disposeProvider();
