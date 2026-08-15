export default function activate(rigyn) {
  rigyn.registerFlag("example-compact-output", {
    description: "Use the compact command response",
    type: "boolean",
    default: false,
  });
  rigyn.registerCommand("example-controls", {
    description: "Show the current example flag",
    async handler(_args, context) {
      context.ui.notify(`Compact output: ${String(rigyn.getFlag("example-compact-output"))}`, "info");
    },
  });
  rigyn.registerShortcut("ctrl+alt+e", {
    description: "Open the example controls notice",
    handler(context) { context.ui.notify("Example shortcut received.", "info"); },
  });
}
