const SCHEMA_VERSION = 1;
const STATE_KEY = "latest-review";
const REVIEW_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);

function reviewState(entry) {
  const value = entry?.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.objective !== "string" || typeof value.status !== "string" || typeof value.summary !== "string") return undefined;
  return value;
}

function boundedText(value, maximum) {
  const codePoints = Array.from(value);
  return codePoints.length <= maximum ? value : `${codePoints.slice(0, maximum - 1).join("")}…`;
}

export default function activate(api) {
  api.session.registerRenderers(SCHEMA_VERSION, {
    renderState(entry) {
      if (entry.key !== STATE_KEY) return undefined;
      const review = reviewState(entry);
      if (review === undefined) return undefined;
      return { lines: [{ spans: [
        { text: `Review ${review.status}`, role: review.status === "success" ? "success" : "warning" },
        { text: ` · ${review.objective}`, role: "title" },
        { text: ` · ${review.summary}`, role: "muted" },
      ] }] };
    },
  });

  api.registerTool({
    name: "review_workflow",
    description: "Run a bounded read-only child review and durably record its normalized completion.",
    promptSnippet: "Run a focused review and retain its completion in the current session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["objective"],
      properties: {
        objective: { type: "string", minLength: 1, maxLength: 8192 },
      },
    },
    async execute(input, context) {
      const target = {
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
      };
      const child = await api.runChild({
        ...target,
        prompt: input.objective,
        context: "fork",
        tools: [...REVIEW_TOOLS],
        appendSystemPrompt: "Act as an independent reviewer. Stay read-only, cite exact evidence, rank findings by impact, and state uncertainty.",
        maxSteps: 16,
        timeoutMs: 180_000,
        outputLimitBytes: 96 * 1024,
        session: "ephemeral",
      });
      const finalText = boundedText(child.finalText, 16_384);
      const record = await api.session.appendState({
        ...target,
        schemaVersion: SCHEMA_VERSION,
        key: STATE_KEY,
        value: {
          objective: input.objective,
          status: child.status,
          summary: child.summary,
          finalText,
          childThreadId: child.threadId,
          truncated: child.truncated || finalText.length !== child.finalText.length,
        },
      });
      return {
        content: JSON.stringify({
          status: child.status,
          summary: child.summary,
          finalText,
          stateEventId: record.eventId,
          usage: child.usage,
        }),
        isError: child.status === "error",
        status: child.status === "success" ? "success" : child.status === "cancelled" ? "warning" : "error",
        summary: child.summary,
        nextActions: child.nextActions,
      };
    },
  });
}
