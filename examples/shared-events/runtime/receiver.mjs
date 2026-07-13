export default function activate(api) {
  api.events.on("gallery.pulse", (payload) => {
    if (payload === null || typeof payload !== "object" || typeof payload.message !== "string") {
      throw new Error("gallery.pulse payload is invalid");
    }
    api.ui.setStatus("shared-events", `received: ${payload.message.slice(0, 120)}`);
  });
}
