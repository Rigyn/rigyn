const SCHEMA_VERSION = 1;
const STATE_KEY = "note";
const MAX_SAVE_ATTEMPTS = 8;

function noteValue(record) {
  const value = record?.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.text !== "string" || typeof value.revision !== "number") return undefined;
  return { text: value.text, revision: value.revision };
}

export default function activate(api) {
  api.session.registerRenderers(SCHEMA_VERSION, {
    renderState(entry) {
      if (entry.key !== STATE_KEY) return undefined;
      const note = noteValue(entry);
      if (note === undefined) return undefined;
      return {
        lines: [{
          spans: [
            { text: `Session note r${note.revision}`, role: "title" },
            { text: ` · ${note.text}`, role: "muted" },
          ],
        }],
      };
    },
  });

  api.registerCommand({
    name: "session-note",
    description: "Save a note in the current durable session; no argument opens the editor.",
    argumentHint: "[text]",
    async execute(context) {
      const target = {
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
      };
      let current = await api.session.readState({
        ...target,
        schemaVersion: SCHEMA_VERSION,
        key: STATE_KEY,
      });
      const previous = noteValue(current);
      let text = context.args.trim();
      if (text === "") {
        const edited = await context.ui.editor("Session note", previous?.text ?? "", context.signal);
        text = edited?.trim() ?? "";
      }
      if (text === "") {
        context.ui.notify("Session note unchanged.");
        return;
      }
      if (text.length > 8192) {
        context.ui.notify("Session note must be at most 8192 characters.", "error");
        return;
      }
      for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
        const revision = (noteValue(current)?.revision ?? 0) + 1;
        const result = await api.session.compareAndAppendState({
          ...target,
          schemaVersion: SCHEMA_VERSION,
          key: STATE_KEY,
          value: { text, revision },
          expectedEventId: current?.eventId ?? null,
        });
        if (result.status === "committed") {
          context.ui.notify(`Session note saved as revision ${revision}.`);
          return;
        }
        current = result.current;
      }
      context.ui.notify("Session note changed repeatedly; retry the save.", "error");
    },
  });
}
