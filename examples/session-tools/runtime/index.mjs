function optionalTarget(input) {
  return {
    threadId: input.threadId,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
  };
}

export default function activate(api) {
  api.registerTool({
    name: "session_catalog",
    description: "List current-workspace sessions or read one explicit branch through bounded transcript pages.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "transcript"] },
        search: { type: "string", maxLength: 256 },
        cursor: { type: "string", minLength: 1, maxLength: 4096 },
        threadId: { type: "string", minLength: 1, maxLength: 200 },
        branch: { type: "string", minLength: 1, maxLength: 200 },
        afterSequence: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
    validate(input) {
      if (input.action === "transcript" && typeof input.threadId !== "string") {
        throw new Error("threadId is required when action is transcript");
      }
      if (input.action === "list" && (input.threadId !== undefined || input.branch !== undefined || input.afterSequence !== undefined)) {
        throw new Error("threadId, branch, and afterSequence are only valid for transcript");
      }
      if (input.action === "transcript" && (input.search !== undefined || input.cursor !== undefined)) {
        throw new Error("search and cursor are only valid for list");
      }
    },
    async execute(input, context) {
      if (input.action === "list") {
        const page = await api.listSessions({
          ...(input.search === undefined ? {} : { search: input.search }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          limit: input.limit ?? 10,
          signal: context.signal,
        });
        return {
          content: JSON.stringify(page),
          isError: false,
          status: "success",
          summary: `Listed ${page.sessions.length} current-workspace session${page.sessions.length === 1 ? "" : "s"}.`,
          nextActions: page.hasMore ? ["Request the next page with nextCursor."] : [],
        };
      }
      const page = await api.getTranscript({
        ...optionalTarget(input),
        ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
        limit: input.limit ?? 10,
        signal: context.signal,
      });
      return {
        content: JSON.stringify(page),
        isError: false,
        status: "success",
        summary: `Read ${page.entries.length} transcript entr${page.entries.length === 1 ? "y" : "ies"} from ${page.threadId}/${page.branch}.`,
        nextActions: page.hasMore && page.nextSequence !== undefined
          ? [`Request the next page with afterSequence ${page.nextSequence}.`]
          : [],
      };
    },
  });

  api.registerCommand({
    name: "session-name",
    description: "Set the current session name; no argument clears it.",
    argumentHint: "[name]",
    async execute(context) {
      const name = context.args.trim();
      if (name.length > 200) {
        context.ui.notify("Session names must be at most 200 characters.", "error");
        return;
      }
      const record = await api.setSessionName({
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
        ...(name === "" ? {} : { name }),
      });
      context.ui.notify(record.name === undefined ? "Session name cleared." : `Session named ${record.name}.`);
    },
  });
}
