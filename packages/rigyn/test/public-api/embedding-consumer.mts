import {
  createEmbeddingHarness,
  createEmbeddingHarnessFromRuntime,
  createInMemoryHarness,
  type CreateInMemoryHarnessOptions,
  type EmbeddingHarness,
  type EmbeddingRunOptions,
  type EmbeddingSession,
} from "rigyn/embedding";
import type { HarnessRuntime, ProviderAdapter } from "rigyn";

const configuredFactory: () => Promise<EmbeddingHarness> = createEmbeddingHarness;
declare const runtime: HarnessRuntime;
const fromRuntime: EmbeddingHarness = createEmbeddingHarnessFromRuntime(runtime);
declare const provider: ProviderAdapter;
const memoryOptions = {
  provider,
  model: "consumer-model",
  api: "openai-chat-completions",
} satisfies CreateInMemoryHarnessOptions;
const memoryFactory: Promise<EmbeddingHarness> = createInMemoryHarness(memoryOptions);

declare const session: EmbeddingSession;
const runOptions = { prompt: "consumer prompt", thinkingLevel: "off" } satisfies EmbeddingRunOptions;
void session.run(runOptions);
void session.start(runOptions).result;
session.steer("next");
session.followUp("later");
void session.waitForIdle();
void session.resolveModel("consumer-model", { provider: "consumer-provider" });
session.setThinkingLevel("medium");
session.setName("consumer");
const unsubscribe = session.subscribe((event) => { void event.sequence; });
unsubscribe();
void [configuredFactory, fromRuntime, memoryFactory];
