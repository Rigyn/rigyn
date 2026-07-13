const TOOL = "guarded_echo";

function metadata(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export default function activate(api) {
  api.registerTool({
    name: TOOL,
    description: "Echo reviewed text unless it is explicitly marked private.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    execute(input) {
      return {
        content: input.text,
        isError: false,
        status: "success",
        summary: `Echoed ${input.text.length} reviewed character${input.text.length === 1 ? "" : "s"}.`,
        nextActions: [],
      };
    },
  });

  api.on("tool_call", (event) => {
    if (event.name !== TOOL) return undefined;
    const text = event.input !== null && typeof event.input === "object" && !Array.isArray(event.input)
      && typeof event.input.text === "string"
      ? event.input.text.trimStart().toLowerCase()
      : "";
    return text.startsWith("private:")
      ? { block: true, reason: "guarded_echo refuses text explicitly marked private" }
      : undefined;
  });

  api.on("tool_result", (event) => event.invocation.name === TOOL
    ? {
        content: JSON.stringify({ echo: event.result.content, reviewed: true }),
        metadata: { ...metadata(event.result.metadata), reviewedBy: api.extensionId },
      }
    : undefined);
}
