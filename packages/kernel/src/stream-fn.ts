import type { StreamFn } from "./types.js";

let defaultStreamFn: StreamFn | undefined;

/** Configure the fallback used when an Agent or low-level loop omits its stream function. */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
  defaultStreamFn = streamFn;
}

export function getDefaultStreamFn(): StreamFn {
  if (defaultStreamFn === undefined) {
    throw new Error("No default stream function configured. Pass streamFn (or legacy streamFunction) explicitly or call setDefaultStreamFn().");
  }
  return defaultStreamFn;
}
