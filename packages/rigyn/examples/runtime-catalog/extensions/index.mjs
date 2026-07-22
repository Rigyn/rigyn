export default function activate(rigyn) {
  rigyn.registerCommand("example-runtime-catalog", {
    description: "Inspect tools, commands, prompts, and skills available to this generation",
    async handler(_args, context) {
      const discovery = await rigyn.getDiscoveryView(context.signal);
      context.ui.notify(JSON.stringify({
        activeTools: rigyn.getActiveTools(),
        allTools: rigyn.getAllTools().map((tool) => tool.name),
        commands: rigyn.getCommands().map((command) => command.name),
        resources: discovery.resources.map((resource) => `${resource.kind}:${resource.name}`),
        truncated: discovery.truncated,
      }), "info");
    },
  });

  rigyn.registerCommand("example-runtime-select", {
    description: "Select one tool and the current model, then queue a follow-up user message",
    async handler(_args, context) {
      const tool = rigyn.getAllTools()[0];
      if (tool !== undefined) rigyn.setActiveTools([tool.name]);
      if (context.model !== undefined) await rigyn.setModel(context.model);
      rigyn.sendUserMessage("Review the updated runtime selection.", { deliverAs: "followUp" });
    },
  });
}
