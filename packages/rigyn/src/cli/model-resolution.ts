import type { ProviderId } from "../core/types.js";
import {
  ModelReferenceResolutionError,
  type ProviderRegistry,
  type ResolvedModelSelection,
} from "../providers/registry.js";

export interface RequestedModelSelection {
  reference: string;
  provider?: ProviderId;
  fallbackProvider?: ProviderId;
  reasoningEffort?: string;
  refresh?: boolean;
  allowUnknownModel?: boolean;
}

export async function resolveRequestedModel(
  registry: Pick<ProviderRegistry, "requireModelReference">,
  request: RequestedModelSelection,
  signal: AbortSignal,
): Promise<ResolvedModelSelection> {
  const common = {
    refresh: request.refresh ?? true,
    allowUnknownModel: request.allowUnknownModel ?? true,
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
  };
  if (request.provider !== undefined) {
    return await registry.requireModelReference(request.reference, signal, {
      ...common,
      provider: request.provider,
    });
  }
  try {
    return await registry.requireModelReference(request.reference, signal, common);
  } catch (error) {
    if (
      !(error instanceof ModelReferenceResolutionError) ||
      error.resolution.match !== "none" ||
      request.fallbackProvider === undefined
    ) throw error;
    return await registry.requireModelReference(request.reference, signal, {
      ...common,
      provider: request.fallbackProvider,
    });
  }
}
