export default function activate(rigyn) {
  rigyn.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nExample extension instruction: keep responses concise.`,
  }));
  rigyn.registerCommand("example-context", {
    description: "Show context usage and request compaction",
    async handler(args, context) {
      const usage = context.getContextUsage();
      const systemPromptCharacters = context.getSystemPrompt().length;
      context.ui.notify(usage === undefined
        ? `Context usage is unavailable. System prompt: ${systemPromptCharacters} characters.`
        : JSON.stringify({ ...usage, systemPromptCharacters }), "info");
      if (args.trim() === "compact") {
        context.compact({ customInstructions: "Preserve active decisions and unresolved work." });
      }
    },
  });
}
