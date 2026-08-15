import { Text } from "rigyn/tui";

export default function activate(rigyn) {
  rigyn.registerEntryRenderer("example-session-note", (entry) => (
    new Text(`Session note · ${String(entry.data?.note ?? "")}`, 0, 0)
  ));
  rigyn.registerCommand("example-session-metadata", {
    description: "Name the session, append a note, and optionally label an entry",
    async handler(args, context) {
      const [name, entryId] = args.trim().split(/\s+/u);
      if (name === undefined || name === "") {
        context.ui.notify("Usage: /example-session-metadata NAME [ENTRY_ID]", "warning");
        return;
      }
      rigyn.setSessionName(name);
      rigyn.appendEntry("example-session-note", { note: `Named ${name}` });
      if (entryId !== undefined) rigyn.setLabel(entryId, `Session ${name}`);
      context.ui.notify(`Session name: ${rigyn.getSessionName() ?? name}`, "info");
    },
  });
}
