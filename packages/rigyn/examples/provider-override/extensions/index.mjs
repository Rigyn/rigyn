const localProvider = {
  name: "Example local Ollama",
  api: "openai-chat-completions",
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "local-only",
  models: [{
    id: "example-local-model",
    name: "Example local model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  }],
};

export default function activate(rigyn) {
  rigyn.registerProvider("ollama", localProvider);
  rigyn.registerCommand("example-provider-disable", {
    description: "Remove this generation's local Ollama replacement",
    async handler(_args, context) {
      rigyn.unregisterProvider("ollama");
      context.ui.notify("The example provider replacement was removed.", "info");
    },
  });
}
