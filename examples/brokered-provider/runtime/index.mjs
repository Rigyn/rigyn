const PROVIDER = "brokered-gallery";
const ENDPOINT = "https://api.example.invalid/v1/generate";
const OBSERVED_AT = "2026-07-13T00:00:00.000Z";

function lastUserText(request) {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  }
  return "";
}

export default function activate(api) {
  api.registerProviderAuth({
    provider: PROVIDER,
    displayName: "Brokered gallery provider",
    methods: [{ kind: "api_key", label: "Gallery API key" }],
    request: {
      origins: ["https://api.example.invalid"],
      apiKey: { header: "x-api-key" },
    },
  });

  api.registerProvider({
    id: PROVIDER,
    async *stream(request, signal) {
      signal.throwIfAborted();
      yield { type: "response_start", model: request.model };
      const response = await api.auth.fetch(PROVIDER, ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: request.model, prompt: lastUserText(request) }),
      }, signal);
      if (!response.ok) throw new Error(`Brokered provider request failed with HTTP ${response.status}`);
      const payload = await response.json();
      if (payload === null || typeof payload !== "object" || typeof payload.text !== "string" || payload.text.length > 1024 * 1024) {
        throw new Error("Brokered provider returned an invalid response");
      }
      const reply = payload.text;
      yield { type: "text_delta", part: 0, text: reply };
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
        id: "brokered-v1",
        provider: PROVIDER,
        displayName: "Brokered v1",
        contextTokens: 32_000,
        maxOutputTokens: 4_096,
        capabilities: {
          tools: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
          reasoning: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
          images: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
        },
      }];
    },
  });
}
