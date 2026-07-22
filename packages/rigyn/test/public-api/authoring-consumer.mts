import {
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "rigyn/extensions";
import { Type } from "typebox";
import {
  defineProviderAdapter,
  type ProviderAdapterDefinition,
} from "rigyn/providers";

export const extension: ExtensionFactory = (rigyn: ExtensionAPI) => {
  rigyn.on("tool_call", () => ({ block: false }));
  rigyn.on("tool_execution_update", (event) => {
    const type: "tool_execution_update" = event.type;
    void [type, event.partialResult];
  });
  rigyn.on("tool_execution_end", (event) => {
    const type: "tool_execution_end" = event.type;
    void [type, event.result, event.isError];
  });
  rigyn.registerCommand("consumer", {
    description: "Consumer command",
    async handler(_args, context) {
      context.ui.notify("ready");
      await context.ui.custom<void>((_tui, _theme, keybindings, done) => {
        keybindings.getKeys("app.model.select");
        keybindings.getKeys("tui.editor.cursorWordLeft");
        done();
        return { render: () => [], invalidate() {} };
      });
    },
  });
  rigyn.registerTool(defineTool({
    name: "consumer_typed_tool",
    label: "Consumer typed tool",
    description: "Public typed tool helper",
    parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: input.text }], details: {} };
    },
  }));
};

const definition = {
  id: "consumer-provider",
  models: [{ id: "consumer-model", capabilities: { tools: true } }],
  async *stream(request, signal) {
    signal.throwIfAborted();
    yield { type: "response_start" as const, model: request.model };
  },
} satisfies ProviderAdapterDefinition;
export const provider = defineProviderAdapter(definition);
