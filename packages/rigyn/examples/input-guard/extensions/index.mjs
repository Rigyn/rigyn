const blockedShell = /(?:^|\s)(?:sudo|shutdown|reboot)(?:\s|$)/iu;

export default function activate(rigyn) {
  rigyn.on("input", (event) => {
    const text = event.text.trim();
    if (text === "/example-ignore") return { action: "handled" };
    if (event.text.length > 4096) return { action: "transform", text: event.text.slice(0, 4096), images: event.images };
    return { action: "continue" };
  });
  rigyn.on("tool_call", (event) => {
    if (event.toolName === "bash" && blockedShell.test(event.input.command)) {
      return { block: true, reason: "The example guard blocks privileged system commands." };
    }
  });
}
