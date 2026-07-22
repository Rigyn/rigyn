export default function activate(rigyn) {
  rigyn.registerCommand("example-session-summary", {
    description: "Summarize the current append-only session tree",
    async handler(_args, context) {
      const header = context.sessionManager.getHeader();
      const entries = context.sessionManager.getEntries();
      const leaf = context.sessionManager.getLeafId();
      context.ui.notify(
        `Session ${header.id}: ${entries.length} entries; leaf ${leaf ?? "root"}.`,
        "info",
      );
    },
  });
}
