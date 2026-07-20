const SCHEMA_VERSION = 1;
const KIND = "note";

function noteFrom(entry) {
  const payload = entry?.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    && typeof payload.text === "string"
    ? payload.text
    : undefined;
}

export default function activate(api) {
  api.session.registerRenderers(SCHEMA_VERSION, {
    renderMessage(entry) {
      if (entry.kind !== KIND) return undefined;
      const text = noteFrom(entry);
      if (text === undefined) return undefined;
      return { lines: [{ spans: [
        { text: "Memory", role: "accent" },
        { text: ` · ${text}`, role: "muted" },
      ] }] };
    },
  });

  api.registerTool({
    name: "session_memory",
    description: "Remember a session-local note or page backward through notes owned by this extension.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["remember", "recall"] },
        text: { type: "string", minLength: 1, maxLength: 8192 },
        beforeEventId: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    validate(input) {
      if (input.action === "remember" && typeof input.text !== "string") {
        throw new Error("text is required when action is remember");
      }
      if (input.action === "recall" && input.text !== undefined) {
        throw new Error("text is only valid when action is remember");
      }
    },
    async execute(input, context) {
      const target = {
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
      };
      if (input.action === "remember") {
        const record = await api.session.appendMessage({
          ...target,
          schemaVersion: SCHEMA_VERSION,
          kind: KIND,
          payload: { text: input.text },
          modelContext: false,
          transcript: false,
        });
        return {
          content: JSON.stringify({ saved: true, eventId: record.eventId }),
          isError: false,
          status: "success",
          summary: "Saved one namespaced session note.",
          nextActions: [],
        };
      }

      const limit = input.limit ?? 10;
      const records = await api.session.readMessages({
        ...target,
        schemaVersion: SCHEMA_VERSION,
        kind: KIND,
        limit,
        ...(input.beforeEventId === undefined ? {} : { beforeEventId: input.beforeEventId }),
      });
      const notes = records.map((record) => ({
        eventId: record.eventId,
        timestamp: record.timestamp,
        text: noteFrom(record) ?? "",
      }));
      const nextBeforeEventId = records.length === limit ? records[0]?.eventId : undefined;
      return {
        content: JSON.stringify({ notes, ...(nextBeforeEventId === undefined ? {} : { nextBeforeEventId }) }),
        isError: false,
        status: "success",
        summary: `Loaded ${notes.length} session note${notes.length === 1 ? "" : "s"}.`,
        nextActions: nextBeforeEventId === undefined
          ? []
          : [`Recall again with beforeEventId ${nextBeforeEventId} to load older notes.`],
      };
    },
  });
}
