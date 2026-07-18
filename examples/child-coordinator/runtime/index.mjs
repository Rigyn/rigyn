const CHILD_TOOLS = ["read", "grep", "find", "ls"];
const MAX_PREVIEW_CHARS = 512;
const MAX_RESULT_CHARS = 4096;

function bounded(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function progressContent(rows) {
  return JSON.stringify({
    children: rows.map(({ index, state, threadId, event, preview }) => ({
      index,
      state,
      ...(threadId === undefined ? {} : { threadId }),
      ...(event === undefined ? {} : { event }),
      ...(preview === "" ? {} : { preview }),
    })),
  });
}

export default function activate(api) {
  api.registerTool({
    name: "coordinate_reviews",
    description: "Run one to four independent review prompts in parallel child sessions and return every settled result.",
    promptSnippet: "Delegate independent bounded reviews in parallel",
    promptGuidelines: [
      "Use coordinate_reviews only when the requested reviews are independent and can share the current stable branch context.",
    ],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: { type: "string", minLength: 1, maxLength: 4096 },
        },
      },
    },
    async execute(input, context) {
      const rows = input.tasks.map((_task, index) => ({ index, state: "queued", preview: "" }));
      const controllers = input.tasks.map(() => new AbortController());
      let lastProgressAt = 0;
      const publish = (force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        context.reportProgress?.({
          type: "result",
          content: progressContent(rows),
          isError: false,
          metadata: { state: "running", childCount: rows.length },
        });
      };
      const cancel = () => {
        for (const controller of controllers) controller.abort(context.signal.reason);
      };
      if (context.signal.aborted) cancel();
      else context.signal.addEventListener("abort", cancel, { once: true });

      try {
        const pending = input.tasks.map((prompt, index) => api.runChild({
          threadId: context.threadId,
          branch: context.branch,
          prompt,
          context: "fork",
          tools: CHILD_TOOLS,
          signal: controllers[index].signal,
          session: "ephemeral",
          onStart(child) {
            rows[index] = { ...rows[index], state: "running", threadId: child.threadId };
            publish(true);
          },
          onEvent(update) {
            const event = update.event.type;
            let preview = rows[index].preview;
            if (event === "text_delta" || event === "reasoning_delta") {
              preview = bounded(`${preview}${update.event.text}`, MAX_PREVIEW_CHARS);
            }
            rows[index] = { ...rows[index], event, preview };
            publish();
          },
        }));
        const settled = await Promise.allSettled(pending);
        const results = settled.map((entry, index) => {
          if (entry.status === "rejected") {
            rows[index] = { ...rows[index], state: "error", event: "rejected" };
            return { index, status: "error", summary: "Child request failed before returning a normalized result.", finalText: "" };
          }
          rows[index] = { ...rows[index], state: entry.value.status, event: "complete" };
          return {
            index,
            status: entry.value.status,
            summary: bounded(entry.value.summary, 1024),
            finalText: bounded(entry.value.finalText, MAX_RESULT_CHARS),
            threadId: entry.value.threadId,
            usage: entry.value.usage,
          };
        });
        publish(true);
        const failures = results.filter((result) => result.status !== "success").length;
        const status = failures === 0 ? "success" : failures === results.length ? "error" : "warning";
        return {
          content: JSON.stringify({ results }),
          isError: status === "error",
          status,
          summary: `Completed ${results.length - failures} of ${results.length} child reviews successfully.`,
          nextActions: failures === 0 ? [] : ["Inspect the failed child summaries before retrying only those tasks."],
          metadata: { childCount: results.length, failureCount: failures },
        };
      } finally {
        context.signal.removeEventListener("abort", cancel);
      }
    },
  });
}
