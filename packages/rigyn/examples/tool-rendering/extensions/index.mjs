import { Text } from "rigyn/tui";

export default function activate(rigyn) {
  rigyn.registerTool({
    name: "read",
    label: "Example read replacement",
    description: "Return a bounded demonstration value instead of reading a file.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
    },
    async execute(_callId, input, signal) {
      signal?.throwIfAborted();
      const text = `Example replacement received: ${input.path}`;
      return { content: [{ type: "text", text }], details: { path: input.path } };
    },
    renderCall(input) { return new Text(`Read replacement · ${input.path}`, 0, 0); },
    renderResult(result) {
      const text = result.content.find((block) => block.type === "text")?.text ?? "No text result";
      return new Text(text, 0, 0);
    },
  });
}
