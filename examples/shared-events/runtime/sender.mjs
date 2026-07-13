export default function activate(api) {
  api.registerCommand({
    name: "event-pulse",
    description: "Send one bounded event to another runtime entry.",
    argumentHint: "[message]",
    async execute(context) {
      const message = context.args.trim() || "ready";
      await api.events.emit("gallery.pulse", { message }, context.signal);
      return { prompt: `Acknowledge that the in-process event receiver observed: ${message}` };
    },
  });
}
