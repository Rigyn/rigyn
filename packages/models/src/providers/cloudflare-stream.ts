import type { Api, Model, ProviderEnv, ProviderStreams } from "../types.js";

export function resolveCloudflareModel<TApi extends Api>(model: Model<TApi>, env?: ProviderEnv): Model<TApi> {
  if (!env) return model;
  const baseUrl = model.baseUrl
    .replaceAll("{CLOUDFLARE_ACCOUNT_ID}", env.CLOUDFLARE_ACCOUNT_ID ?? "{CLOUDFLARE_ACCOUNT_ID}")
    .replaceAll("{CLOUDFLARE_GATEWAY_ID}", env.CLOUDFLARE_GATEWAY_ID ?? "{CLOUDFLARE_GATEWAY_ID}");
  return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

export function cloudflareStreams(streams: ProviderStreams): ProviderStreams {
  return {
    stream: (model, context, options) => streams.stream(resolveCloudflareModel(model, options?.env), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(resolveCloudflareModel(model, options?.env), context, options),
  };
}
