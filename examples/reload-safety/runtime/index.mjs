export default function activate(api) {
  api.ui.setStatus("reload-safety", "generation active");
  api.registerCommand({
    name: "reload-probe",
    description: "Confirm that the active generation still handles commands.",
    execute() {
      return { prompt: "Report that the active extension generation handled this reload probe." };
    },
  });
  api.onDispose(() => {
    // Release package-owned timers, sockets, files, and child processes here.
  });
}
