const model = {
  id: "example-chat",
  name: "Example chat model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_384,
  maxTokens: 2_048,
};

export default function activate(rigyn) {
  rigyn.registerProvider("example-managed", {
    name: "Example managed provider",
    api: "openai-completions",
    baseUrl: "https://provider.invalid/v1",
    models: [model],
    async refreshModels(context) {
      context.signal?.throwIfAborted();
      return [model];
    },
    oauth: {
      name: "Example subscription",
      async login() { throw new Error("Replace the example login with a reviewed OAuth flow."); },
      async refreshToken(credentials) { return credentials; },
      getApiKey(credentials) { return credentials.access; },
    },
  });
}
