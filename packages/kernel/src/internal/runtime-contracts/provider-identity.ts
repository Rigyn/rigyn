export type ProviderId =
  | "openai"
  | "azure-openai"
  | "anthropic"
  | "gemini"
  | "vertex"
  | "bedrock"
  | "openrouter"
  | "ollama"
  | "openai-compatible"
  | (string & {});

/** Controls whether validated, durable image sources may cross a model boundary. */
export type OutboundImagePolicy = "allow" | "block";

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "context_limit"
  | "content_filter"
  | "refusal"
  | "pause"
  | "cancelled"
  | "aborted"
  | "error"
  | "incomplete"
  | "unknown";
