export default function activate(rigyn) {
  const counts = {
    agentStart: 0,
    agentEnd: 0,
    agentSettled: 0,
    turnStart: 0,
    turnEnd: 0,
    messageStart: 0,
    messageUpdate: 0,
    messageEnd: 0,
    toolStart: 0,
    toolUpdate: 0,
    toolEnd: 0,
  };
  for (const [event, key] of [
    ["agent_start", "agentStart"],
    ["agent_end", "agentEnd"],
    ["agent_settled", "agentSettled"],
    ["turn_start", "turnStart"],
    ["turn_end", "turnEnd"],
    ["message_start", "messageStart"],
    ["message_update", "messageUpdate"],
    ["message_end", "messageEnd"],
    ["tool_execution_start", "toolStart"],
    ["tool_execution_update", "toolUpdate"],
    ["tool_execution_end", "toolEnd"],
  ]) {
    rigyn.on(event, () => { counts[key] += 1; });
  }
  rigyn.registerCommand("example-lifecycle-status", {
    description: "Show lifecycle events observed by this generation",
    async handler(_args, context) {
      context.ui.notify(JSON.stringify(counts), "info");
    },
  });
  rigyn.onDispose(() => { for (const key of Object.keys(counts)) counts[key] = 0; });
}
