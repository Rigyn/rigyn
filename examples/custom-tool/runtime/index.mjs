function metrics(text) {
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
  const lines = text.split(/\r\n?|\n/u).length;
  const bytes = new TextEncoder().encode(text).byteLength;
  return { lines, words, bytes };
}

export default function activate(api) {
  api.registerTool({
    name: "text_metrics",
    description: "Count lines, whitespace-delimited words, and UTF-8 bytes in supplied text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 65536 },
      },
    },
    execute(input) {
      const measured = metrics(input.text);
      return {
        content: JSON.stringify({ metrics: measured }),
        isError: false,
        status: "success",
        summary: `Measured ${measured.lines} line${measured.lines === 1 ? "" : "s"}, ${measured.words} word${measured.words === 1 ? "" : "s"}, and ${measured.bytes} UTF-8 byte${measured.bytes === 1 ? "" : "s"}.`,
        nextActions: [],
      };
    },
  });
}
