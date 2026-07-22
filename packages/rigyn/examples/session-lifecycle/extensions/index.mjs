export default function activate(rigyn) {
  const observed = [];
  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_before_compact",
    "session_compact",
    "session_before_tree",
    "session_tree",
    "session_info_changed",
    "session_shutdown",
  ]) {
    rigyn.on(event, () => {
      observed.push(event);
      if (observed.length > 32) observed.shift();
      if (event === "session_before_tree") return { customInstructions: "Retain decisions from the selected branch." };
    });
  }

  rigyn.registerCommand("example-session-lifecycle", {
    description: "Show recently observed session transition events",
    async handler(_args, context) { context.ui.notify(JSON.stringify(observed), "info"); },
  });
  rigyn.registerCommand("example-session-navigate", {
    description: "Navigate to a session entry while requesting a branch summary",
    async handler(args, context) {
      const targetId = args.trim();
      if (targetId === "") { context.ui.notify("Usage: /example-session-navigate ENTRY_ID", "warning"); return; }
      await context.navigateTree(targetId, { summarize: true, label: "example branch" });
    },
  });
  rigyn.registerCommand("example-session-compact", {
    description: "Request compaction with focused instructions",
    async handler(_args, context) {
      context.compact({ customInstructions: "Preserve decisions and unfinished work." });
    },
  });
}
