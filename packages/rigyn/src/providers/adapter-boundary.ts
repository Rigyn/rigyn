import { snapshotAdapterEvent } from "@rigyn/kernel/runtime/core/adapter-event";

import { errorMessage } from "../core/errors.js";
import type { AdapterEvent } from "../core/types.js";

export async function* validatedProviderAdapterEvents(
  source: AsyncIterable<unknown>,
): AsyncIterable<AdapterEvent> {
  let bodyStarted = false;
  for await (const value of source) {
    let event: AdapterEvent;
    try {
      event = snapshotAdapterEvent(value);
    } catch (error) {
      yield {
        type: "error",
        error: {
          category: "protocol",
          message: `Provider returned an invalid adapter event: ${errorMessage(error)}`,
          retryable: false,
          partial: bodyStarted,
          bodyStarted,
        },
      };
      return;
    }
    if (event.type !== "error" && event.type !== "response_start") bodyStarted = true;
    yield event;
  }
}
