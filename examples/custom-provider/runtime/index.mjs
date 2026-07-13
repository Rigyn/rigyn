const MODEL = "gallery-offline-v1";
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
  return "empty prompt";
}

export default function activate(api) {
  api.registerProvider({
    id: "gallery-offline",
    async *stream(request, signal) {
      signal.throwIfAborted();
      const reply = `Offline provider: ${lastUserText(request.messages)}`;
      yield { type: "response_start", model: MODEL };
      yield { type: "text_delta", part: 0, text: reply };
      yield {
        type: "usage",
        usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
        semantics: "final",
      };
      yield {
        type: "response_end",
        reason: "stop",
        state: {
          kind: "chat_completions",
          assistantMessage: { role: "assistant", content: reply },
        },
      };
    },
    async listModels(signal) {
      signal.throwIfAborted();
      return [{
        id: MODEL,
        provider: "gallery-offline",
        displayName: "Gallery Offline",
        contextTokens: 8192,
        maxOutputTokens: 1024,
        capabilities: {
          tools: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
          reasoning: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
          images: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
        },
        metadata: { offline: true },
      }];
    },
  });
}
