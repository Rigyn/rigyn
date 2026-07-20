const PROVIDER = "lifecycle-offline";
const MODEL = "lifecycle-offline-v1";
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

function adapter() {
  return {
    id: PROVIDER,
    async *stream(request, signal) {
      signal.throwIfAborted();
      const text = `Lifecycle provider handled ${request.messages.length} message${request.messages.length === 1 ? "" : "s"}.`;
      yield { type: "response_start", model: MODEL };
      yield { type: "text_delta", part: 0, text };
      yield { type: "response_end", reason: "stop", state: {
        kind: "chat_completions",
        assistantMessage: { role: "assistant", content: text },
      } };
    },
    async listModels(signal) {
      signal.throwIfAborted();
      return [{
        id: MODEL,
        provider: PROVIDER,
        displayName: "Lifecycle Offline",
        contextTokens: 4096,
        maxOutputTokens: 512,
        capabilities: {
          tools: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
          reasoning: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
          images: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
        },
        metadata: { offline: true, example: "provider-lifecycle" },
      }];
    },
  };
}

export default function activate(api) {
  let disposeProvider;
  let active = false;

  const enable = () => {
    if (active) return false;
    disposeProvider = api.registerProvider(adapter());
    active = true;
    return true;
  };
  const disable = async () => {
    if (!active) return false;
    const dispose = disposeProvider;
    disposeProvider = undefined;
    active = false;
    await dispose?.();
    return true;
  };

  enable();
  api.registerCommand({
    name: "provider-lifecycle",
    description: "Show, enable, or disable the extension-owned offline provider.",
    argumentHint: "[status|enable|disable]",
    getArgumentCompletions(prefix) {
      const selected = prefix.trim().toLowerCase();
      return ["status", "enable", "disable"]
        .filter((value) => value.startsWith(selected))
        .map((value) => ({ value, label: value }));
    },
    async execute(context) {
      const action = context.args.trim().toLowerCase() || "status";
      if (action === "enable") enable();
      else if (action === "disable") await disable();
      else if (action !== "status") {
        context.ui.notify("Expected status, enable, or disable.", "error");
        return;
      }
      context.ui.notify(`${PROVIDER} is ${active ? "enabled" : "disabled"}.`);
    },
  });
}
