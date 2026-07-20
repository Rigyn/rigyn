export default function activate(api) {
  api.registerTool({
    name: "session_usage_summary",
    description: "Read durable aggregate token, cache, cost, and duration metrics for this session branch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute(_input, context) {
      const snapshot = await api.getSessionUsage({
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
      });
      return {
        content: JSON.stringify({
          threadId: snapshot.threadId,
          branch: snapshot.branch,
          runs: snapshot.runCount,
          responses: snapshot.responseCount,
          usageEvents: snapshot.usageEventCount,
          tokens: snapshot.usage,
          cache: snapshot.cache,
        }),
        isError: false,
        status: "success",
        summary: `Summarized ${snapshot.responseCount} provider response${snapshot.responseCount === 1 ? "" : "s"} across ${snapshot.runCount} run${snapshot.runCount === 1 ? "" : "s"}.`,
        nextActions: snapshot.cache.status === "low_reuse"
          ? ["Inspect prompt churn before changing cache policy."]
          : [],
      };
    },
  });
}
