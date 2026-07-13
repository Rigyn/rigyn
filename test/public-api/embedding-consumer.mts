import {
  createEmbeddingHarness,
  createInMemoryHarness,
  type EmbeddingHarness,
  type EmbeddingRunOptions,
  type InMemoryHarness,
  type InMemoryRunOptions,
} from "rigyn/embedding";
import type { ProviderAdapter } from "rigyn/core";

const configuredFactory: () => Promise<EmbeddingHarness> = createEmbeddingHarness;
void configuredFactory;

declare const configured: EmbeddingHarness;
const configuredRun = {
  provider: "consumer-provider",
  model: "consumer-model",
  prompt: "consumer prompt",
} satisfies EmbeddingRunOptions;
void configured.run(configuredRun);
void configured.resourceCatalog();
void configured.reload();
// @ts-expect-error the task-focused facade must not expose the credential store
void configured.credentials;
// @ts-expect-error the task-focused facade must not expose the service
void configured.service;

declare const provider: ProviderAdapter;
const memoryFactory: Promise<InMemoryHarness> = createInMemoryHarness({
  provider,
  model: "consumer-model",
});
void memoryFactory;
const memoryRun = { prompt: "offline consumer" } satisfies InMemoryRunOptions;
void memoryRun;
