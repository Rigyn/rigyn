export default function activate(rigyn) {
  rigyn.registerCommand("example-hello", {
    description: "Show a greeting from the starter extension",
    async handler(args, context) {
      const name = args.trim() || "developer";
      context.ui.notify(`Hello, ${name}.`, "info");
    },
  });

  rigyn.registerTool({
    name: "example_text_length",
    label: "Text length",
    description: "Count Unicode code points in a short text value.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", maxLength: 4096 } },
    },
    async execute(_callId, input) {
      const count = [...input.text].length;
      return {
        content: [{ type: "text", text: JSON.stringify({ codePoints: count }) }],
        details: { codePoints: count },
      };
    },
  });
}
