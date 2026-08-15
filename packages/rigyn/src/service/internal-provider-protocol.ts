import type { ModelProtocolFamily } from "../core/types.js";
import {
  runtimeProviderProtocolFamily,
  type RuntimeProviderConfig,
} from "./provider-factory.js";

export function runtimeProviderModelProtocolFamily(
  config: RuntimeProviderConfig,
  modelId: string,
): ModelProtocolFamily | undefined {
  if (config.kind !== "routed") return runtimeProviderProtocolFamily(config);
  return config.routes.find((route) => route.model === modelId)?.protocolFamily;
}
