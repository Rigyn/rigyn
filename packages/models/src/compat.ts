import type { Context, Model, SimpleStreamOptions } from "./contracts.js";
import { streamByApi } from "./protocol-transports.js";

export function streamSimple(model: Model, context: Context, options?: SimpleStreamOptions) {
  return streamByApi(model, context, options);
}

export function completeSimple(model: Model, context: Context, options?: SimpleStreamOptions) {
  return streamSimple(model, context, options).result();
}

export const stream = streamSimple;
export const complete = completeSimple;
