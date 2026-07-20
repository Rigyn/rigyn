const READ_ONLY_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
const REPLACEMENT_PROMPT = [
  "You are a focused code-review specialist.",
  "Inspect only the delegated objective and cite concrete workspace evidence.",
  "Return findings, uncertainty, and one bounded recommendation.",
].join("\n");
const APPENDED_PROMPT = [
  "For this delegated review, stay read-only.",
  "Do not broaden the requested scope or propose edits without evidence.",
].join("\n");

export default function activate(api) {
  api.registerTool({
    name: "specialist_review",
    description: "Delegate one bounded read-only review to an in-process child session.",
    promptSnippet: "Delegate a focused read-only review with explicit child instructions",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["objective", "promptMode"],
      properties: {
        objective: { type: "string", minLength: 1, maxLength: 8192 },
        promptMode: { type: "string", enum: ["append", "replace"] },
      },
    },
    async execute(input, context) {
      const child = await api.runChild({
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
        prompt: input.objective,
        context: "fork",
        tools: [...READ_ONLY_TOOLS],
        ...(input.promptMode === "replace"
          ? { systemPrompt: REPLACEMENT_PROMPT }
          : { appendSystemPrompt: APPENDED_PROMPT }),
        maxSteps: 12,
        timeoutMs: 120_000,
        outputLimitBytes: 64 * 1024,
        session: "ephemeral",
      });
      return {
        content: JSON.stringify({
          status: child.status,
          summary: child.summary,
          finalText: child.finalText,
          usage: child.usage,
          truncated: child.truncated,
        }),
        isError: child.status === "error",
        status: child.status === "success" ? "success" : child.status === "cancelled" ? "warning" : "error",
        summary: child.summary,
        nextActions: child.nextActions,
      };
    },
  });
}
