import {
  createEmbeddingHarness,
  createEmbeddingHarnessFromRuntime,
  createInMemoryHarness,
  type CreateInMemoryHarnessOptions,
  type EmbeddingHarness,
  type EmbeddingRunOptions,
  type EmbeddingSession,
} from "rigyn/embedding";
import {
  defineTool,
  type CreateHarnessRuntimeOptions,
  type HarnessRuntime,
  type ProviderAdapter,
  type ToolAuthorizationHandler,
} from "rigyn";
import { Type } from "typebox";

const configuredFactory: () => Promise<EmbeddingHarness> = createEmbeddingHarness;
const toolAuthorizationHandler: ToolAuthorizationHandler = () => ({ decision: "allow_once" });
const configuredOptions = { toolAuthorizationHandler } satisfies CreateHarnessRuntimeOptions;
void createEmbeddingHarness(configuredOptions);
declare const runtime: HarnessRuntime;
const fromRuntime: EmbeddingHarness = createEmbeddingHarnessFromRuntime(runtime);
declare const provider: ProviderAdapter;
const customTool = defineTool({
  name: "embedding_probe",
  label: "Embedding probe",
  description: "Exercise the public embedding tool contract",
  parameters: Type.Object({ value: Type.String() }),
  async execute(_toolCallId, input, _signal, _onUpdate, context) {
    return {
      content: [{ type: "text", text: `${context.cwd}:${input.value}` }],
      details: null,
    };
  },
});
const memoryOptions = {
  provider,
  model: "consumer-model",
  api: "openai-chat-completions",
  customTools: [customTool],
  toolAuthorizationHandler,
} satisfies CreateInMemoryHarnessOptions;
const memoryFactory: Promise<EmbeddingHarness> = createInMemoryHarness(memoryOptions);

declare const session: EmbeddingSession;
const runOptions = { prompt: "consumer prompt", thinkingLevel: "off" } satisfies EmbeddingRunOptions;
void session.run(runOptions);
void session.start(runOptions).result;
session.steer("next");
session.followUp("later");
void session.waitForIdle();
void session.suspendedRun?.effects.map((effect) => `${effect.effectId}:${effect.status}`);
void session.recoverInterruptedRun({
  resolutions: [{ effectId: "verified-effect", outcome: "abandoned" }],
});
void session.resolveModel("consumer-model", { provider: "consumer-provider" });
session.setThinkingLevel("medium");
session.setName("consumer");
const unsubscribe = session.subscribe((event) => { void event.sequence; });
unsubscribe();
void [configuredFactory, fromRuntime, memoryFactory];
