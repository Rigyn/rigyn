import type { CanonicalMessage, ProviderRequest } from "../core/types.js";
import { InvalidProviderRequestError } from "./transport.js";

/**
 * Empty canonical turns carry no user intent and several provider protocols
 * reject empty message containers. Whitespace remains intentional content.
 */
export function providerWireRequest(
  request: ProviderRequest,
  preserveLastAssistantMarker = false,
): ProviderRequest {
  let changed = false;
  const messages: CanonicalMessage[] = [];
  const stateMarker = preserveLastAssistantMarker
    ? request.messages.findLastIndex((message) => message.role === "assistant")
    : -1;
  for (const [index, message] of request.messages.entries()) {
    const content = message.content.filter((block) => block.type !== "text" || block.text !== "");
    if (content.length === 0) {
      if (index === stateMarker) {
        if (content.length !== message.content.length) changed = true;
        messages.push(content.length === message.content.length ? message : { ...message, content });
        continue;
      }
      changed = true;
      continue;
    }
    if (content.length !== message.content.length) {
      changed = true;
      messages.push({ ...message, content });
    } else {
      messages.push(message);
    }
  }
  if (messages.length === 0) {
    throw new InvalidProviderRequestError("Provider request requires at least one non-empty message");
  }
  return changed ? { ...request, messages } : request;
}
