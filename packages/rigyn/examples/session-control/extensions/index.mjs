export default function activate(rigyn) {
  rigyn.registerCommand("example-session-new", {
    description: "Start a new session when the active session is idle",
    async handler(_args, context) {
      const result = await context.newSession();
      context.ui.notify(result.cancelled ? "Session change was cancelled." : "New session started.", "info");
    },
  });
  rigyn.registerCommand("example-session-fork", {
    description: "Fork at a session entry ID",
    async handler(args, context) {
      const entryId = args.trim();
      if (entryId === "") {
        context.ui.notify("Usage: /example-session-fork ENTRY_ID", "warning");
        return;
      }
      const result = await context.fork(entryId, { position: "at" });
      context.ui.notify(result.cancelled ? "Fork was cancelled." : `Forked at ${entryId}.`, "info");
    },
  });
  rigyn.registerCommand("example-session-switch", {
    description: "Switch to an explicit session JSONL path",
    async handler(args, context) {
      const sessionPath = args.trim();
      if (sessionPath === "") {
        context.ui.notify("Usage: /example-session-switch PATH", "warning");
        return;
      }
      const result = await context.switchSession(sessionPath);
      context.ui.notify(result.cancelled ? "Session switch was cancelled." : "Session switched.", "info");
    },
  });
  rigyn.registerCommand("example-session-status", {
    description: "Wait for idle and inspect pending-message and system-prompt state",
    async handler(_args, context) {
      const pendingMessages = context.hasPendingMessages();
      const options = context.getSystemPromptOptions();
      await context.waitForIdle();
      context.ui.notify(JSON.stringify({
        pendingMessages,
        promptCwd: options.cwd,
        selectedTools: options.selectedTools ?? [],
      }), "info");
    },
  });
  rigyn.registerCommand("example-session-abort", {
    description: "Request cancellation of active agent work",
    async handler(_args, context) {
      context.abort();
      context.ui.notify("Cancellation requested.", "info");
    },
  });
  rigyn.registerCommand("example-session-reload", {
    description: "Reload host-owned extensions and resources",
    async handler(_args, context) {
      await context.reload();
      return;
    },
  });
  rigyn.registerCommand("example-session-shutdown", {
    description: "Request graceful host shutdown",
    async handler(_args, context) {
      context.shutdown();
    },
  });
}
