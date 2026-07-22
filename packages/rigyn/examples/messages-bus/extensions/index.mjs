import { Text } from "rigyn/tui";

export default function activate(rigyn) {
  const stop = rigyn.events.on("example-message", (payload) => {
    rigyn.sendMessage({ customType: "example-note", content: String(payload), display: true });
  });
  rigyn.onDispose(stop);
  rigyn.registerMessageRenderer("example-note", (message) => new Text(String(message.content), 0, 0));
  rigyn.registerCommand("example-message", {
    description: "Emit a generation-local event that becomes a custom message",
    async handler(args) { rigyn.events.emit("example-message", args.trim() || "Example message"); },
  });
}
