function shortHash(value) {
  return value.length <= 16 ? value : `${value.slice(0, 16)}…`;
}

export default function activate(api) {
  api.registerCommand({
    name: "prompt-info",
    description: "Show metadata for the latest redacted host prompt without copying its text.",
    async execute(context) {
      const snapshot = await api.getSystemPromptSnapshot({
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
      });
      if (snapshot === undefined) {
        context.ui.notify("No durable prompt snapshot is available for this branch.", "warning");
        return;
      }
      const model = snapshot.model === undefined
        ? "model unavailable"
        : `${snapshot.model.provider}/${snapshot.model.model}`;
      context.ui.notify(
        `Prompt snapshot: ${snapshot.bytes} bytes · sha256 ${shortHash(snapshot.sha256)} · ${model} · ${snapshot.redacted ? "redacted" : "no redactions needed"}`,
      );
    },
  });
}
