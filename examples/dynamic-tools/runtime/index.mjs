const LOADER = "load_text_toolset";
const OPTIONAL = ["text_uppercase", "text_lowercase"];

async function select(api, target, preset) {
  const active = await api.getActiveTools(target);
  const retained = active.filter((name) => !OPTIONAL.includes(name));
  const names = [...new Set([
    ...retained,
    LOADER,
    ...(preset === "text" ? OPTIONAL : []),
  ])];
  return await api.setActiveTools({ ...target, names });
}

export default function activate(api) {
  const runBranches = new Map();

  api.on("agent_start", (event) => {
    runBranches.set(event.runId, event.branch);
  });
  api.on("agent_settled", (event) => {
    runBranches.delete(event.runId);
  });

  api.registerTool({
    name: LOADER,
    description: "Activate or unload the focused text toolset for the next provider turn.",
    promptSnippet: "load_text_toolset changes which focused text tools are sent on the next model turn.",
    promptGuidelines: ["Use load_text_toolset with preset text before calling text_uppercase or text_lowercase."],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["preset"],
      properties: {
        preset: { type: "string", enum: ["text", "loader-only"] },
      },
    },
    async execute(input, context) {
      const branch = runBranches.get(context.runId);
      const activeTools = await select(api, {
        threadId: context.threadId,
        ...(branch === undefined ? {} : { branch }),
        signal: context.signal,
      }, input.preset);
      return {
        content: JSON.stringify({ activeTools, applies: "next-provider-turn" }),
        isError: false,
        status: "success",
        summary: input.preset === "text"
          ? "Activated the two focused text tools for the next provider turn."
          : "Unloaded the focused text tools for the next provider turn.",
        nextActions: input.preset === "text"
          ? ["Call text_uppercase or text_lowercase on the next provider turn."]
          : [],
      };
    },
  });

  api.registerTool({
    name: "text_uppercase",
    description: "Convert supplied text to uppercase.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 4096 } },
    },
    execute(input) {
      return {
        content: input.text.toUpperCase(),
        isError: false,
        status: "success",
        summary: "Converted text to uppercase.",
        nextActions: [],
      };
    },
  });

  api.registerTool({
    name: "text_lowercase",
    description: "Convert supplied text to lowercase.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 4096 } },
    },
    execute(input) {
      return {
        content: input.text.toLowerCase(),
        isError: false,
        status: "success",
        summary: "Converted text to lowercase.",
        nextActions: [],
      };
    },
  });

  api.registerCommand({
    name: "dynamic-tools",
    description: "Select the loader-only or text-tool preset for this session.",
    argumentHint: "[loader-only|text]",
    getArgumentCompletions(prefix) {
      return ["loader-only", "text"]
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
    },
    async execute(context) {
      const preset = context.args.trim() || "loader-only";
      if (preset !== "loader-only" && preset !== "text") {
        context.ui.notify("Expected /dynamic-tools loader-only or /dynamic-tools text.", "error");
        return;
      }
      const active = await select(api, {
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
      }, preset);
      context.ui.notify(`Active tool selection queued: ${active.join(", ")}.`);
    },
  });
}
