import type { AssistantMessage } from "../types.js";

const overflowPatterns = [
  /prompt is too long/iu,
  /request_too_large/iu,
  /input is too long for requested model/iu,
  /exceeds (?:the )?(?:model'?s )?(?:maximum )?context (?:window|length)/iu,
  /input token count.*exceeds the maximum/iu,
  /maximum prompt length is \d+/iu,
  /reduce the length of the messages/iu,
  /maximum context length is \d+ tokens/iu,
  /maximum allowed input length/iu,
  /longer than the model'?s context length/iu,
  /exceeds the limit of \d+/iu,
  /exceeds the available context size/iu,
  /greater than the context length/iu,
  /context window exceeds limit/iu,
  /exceeded model token limit/iu,
  /too large for model with \d+ maximum context length/iu,
  /prompt has [\d,]+ tokens?.*configured context size/iu,
  /model_context_window_exceeded/iu,
  /prompt too long; exceeded (?:max )?context length/iu,
  /range of input length should be/iu,
  /context[_ ]length[_ ]exceeded/iu,
  /too many tokens/iu,
  /token limit exceeded/iu,
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/iu,
];
const notOverflow = [/(?:throttling error|service unavailable):/iu, /rate limit/iu, /too many requests/iu];

export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  const error = message.errorMessage;
  if (message.stopReason === "error" && error !== undefined && !notOverflow.some((pattern) => pattern.test(error)) && overflowPatterns.some((pattern) => pattern.test(error))) return true;
  if (contextWindow !== undefined && message.stopReason === "stop" && message.usage.input + message.usage.cacheRead > contextWindow) return true;
  return contextWindow !== undefined && message.stopReason === "length" && message.usage.output === 0 && message.usage.input + message.usage.cacheRead >= contextWindow * 0.99;
}

export function getOverflowPatterns(): RegExp[] { return [...overflowPatterns]; }
