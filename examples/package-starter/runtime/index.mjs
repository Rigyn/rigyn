export default function activate(api) {
  api.registerCommand({
    name: "starter-review",
    description: "Turn a subject into a small evidence-led review prompt.",
    argumentHint: "[subject]",
    execute(context) {
      const subject = context.args.trim() || "the current change";
      return {
        prompt: `Review ${subject}. Report concrete evidence, risks, and the smallest useful next action.`,
      };
    },
  });

  api.ui.setStatus("package-starter", "ready");
}
