export default function activate(rigyn) {
  rigyn.on("resources_discover", () => ({
    skillPaths: ["skills"],
    promptPaths: ["prompts"],
    themePaths: [],
  }));
  rigyn.registerCommand("example-dynamic-ready", {
    description: "Confirm that the dynamic package runtime is active",
    async handler(_args, context) {
      context.ui.notify("Dynamic example resources are active.", "info");
    },
  });
}
