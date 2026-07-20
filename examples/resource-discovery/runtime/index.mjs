export default function activate(api) {
  api.registerTool({
    name: "discover_resources",
    description: "List bounded metadata for commands, prompts, and skills available in the active host.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["all", "command", "prompt", "skill"] },
        query: { type: "string", maxLength: 256 },
      },
    },
    async execute(input, context) {
      const view = await api.getDiscoveryView(context.signal);
      const kind = input.kind ?? "all";
      const query = input.query?.trim().toLowerCase() ?? "";
      const resources = view.resources.filter((entry) => {
        if (kind !== "all" && entry.kind !== kind) return false;
        if (query === "") return true;
        return [entry.name, entry.description ?? "", "argumentHint" in entry ? entry.argumentHint ?? "" : ""]
          .some((value) => value.toLowerCase().includes(query));
      });
      return {
        content: JSON.stringify({ resources, truncated: view.truncated, omitted: view.omitted }),
        isError: false,
        status: "success",
        summary: `Found ${resources.length} matching host resource${resources.length === 1 ? "" : "s"}.`,
        nextActions: view.truncated
          ? ["Refine kind or query because the host catalog was bounded before filtering."]
          : [],
      };
    },
  });
}
