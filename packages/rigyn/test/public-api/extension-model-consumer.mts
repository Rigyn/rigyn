import { createAssistantMessageEventStream, type Api, type Model } from "@rigyn/models";
import type { ExtensionAPI, ExtensionContext } from "rigyn/extensions";

declare const extension: ExtensionAPI;
declare const context: ExtensionContext;
declare const model: Model<Api>;

const selected: Model<Api> | undefined = context.model;
const found: Model<Api> | undefined = context.modelRegistry.find("provider", "model");
void extension.setModel(model);
extension.setThinkingLevel("xhigh");
const level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" = extension.getThinkingLevel();

extension.registerProvider("custom-provider", {
  api: "custom-provider-events",
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  models: [{
    id: "custom-model",
    name: "Custom model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  }],
  streamSimple(publicModel, publicContext) {
    const typedModel: Model<Api> = publicModel;
    void publicContext.messages;
    void typedModel.api;
    return createAssistantMessageEventStream();
  },
});

void [selected, found, level];
