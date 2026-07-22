export default function activate(rigyn) {
  rigyn.on("project_trust", async (event, context) => {
    if (!context.hasUI) return { trusted: "undecided" };
    const accepted = await context.ui.confirm(
      "Project trust",
      `Load executable project resources from ${event.cwd}?`,
    );
    return { trusted: accepted ? "yes" : "no" };
  });
}
