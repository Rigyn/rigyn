import { createInterface } from "node:readline";

const SERVER_NAME = "fixed-gallery-mcp";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  if (message.method === "notifications/initialized") return;
  const id = message.id;
  if (id === undefined) return;

  if (message.method === "initialize") {
    const requested = message.params !== null && typeof message.params === "object"
      ? message.params.protocolVersion
      : undefined;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: "1.0.0" },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{
          name: "reverse_text",
          description: "Reverse supplied text by Unicode code point.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: { text: { type: "string", minLength: 1, maxLength: 4096 } },
          },
        }],
      },
    });
    return;
  }

  if (message.method === "tools/call") {
    const params = message.params;
    const text = params !== null && typeof params === "object" && params.name === "reverse_text"
      && params.arguments !== null && typeof params.arguments === "object"
      && typeof params.arguments.text === "string"
      ? params.arguments.text
      : undefined;
    if (text === undefined || text.length === 0 || text.length > 4096) {
      error(id, -32602, "reverse_text requires non-empty text of at most 4096 characters");
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: [...text].reverse().join("") }],
        isError: false,
      },
    });
    return;
  }

  error(id, -32601, "Method not found");
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (Buffer.byteLength(line) > 64 * 1024) {
    error(null, -32700, "Frame exceeds 64 KiB");
    return;
  }
  try {
    handle(JSON.parse(line));
  } catch {
    error(null, -32700, "Invalid JSON");
  }
});
