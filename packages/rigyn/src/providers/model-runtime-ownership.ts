import type { ModelRuntime } from "./model-compat.js";
import type { ModelRegistry } from "./model-registry.js";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();
let createRuntime: ((registry: ModelRegistry) => ModelRuntime) | undefined;

export function installModelRuntimeFactory(factory: (registry: ModelRegistry) => ModelRuntime): void {
  createRuntime = factory;
}

export function registerModelRuntime(registry: ModelRegistry, runtime: ModelRuntime): void {
  runtimes.set(registry, runtime);
}

export function modelRuntimeForInternalRegistry(registry: ModelRegistry): ModelRuntime {
  const existing = runtimes.get(registry);
  if (existing !== undefined) return existing;
  if (createRuntime === undefined) throw new Error("ModelRuntime factory is not initialized");
  return createRuntime(registry);
}
