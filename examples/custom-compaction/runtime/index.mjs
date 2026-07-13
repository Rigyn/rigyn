const MAX_INCLUDED_MESSAGES = 24;
const MAX_MESSAGE_BYTES = 480;
const MAX_INSTRUCTION_BYTES = 480;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function truncate(value, maxBytes) {
  const bytes = encoder.encode(value);
  return bytes.byteLength <= maxBytes
    ? value
    : `${decoder.decode(bytes.slice(0, maxBytes - 3))}…`;
}

function blockText(block) {
  if (block.type === "text") return block.text;
  if (block.type === "tool_call") return `[tool call: ${block.name}]`;
  if (block.type === "tool_result") return `[tool ${block.isError ? "error" : "result"}: ${block.name}] ${block.content}`;
  if (block.type === "image") return `[image: ${block.mediaType}]`;
  return "[provider state omitted]";
}

function messageLine(message) {
  const text = message.content.map(blockText).join(" ").replace(/\s+/gu, " ").trim();
  const excerpt = truncate(text, MAX_MESSAGE_BYTES);
  return `- ${message.role}: ${excerpt || "[empty]"}`;
}

function outline(messages) {
  if (messages.length <= MAX_INCLUDED_MESSAGES) {
    return { lines: messages.map(messageLine), included: messages.length, omitted: 0 };
  }
  const side = MAX_INCLUDED_MESSAGES / 2;
  const omitted = messages.length - MAX_INCLUDED_MESSAGES;
  return {
    lines: [
      ...messages.slice(0, side).map(messageLine),
      `- [${omitted} middle message${omitted === 1 ? "" : "s"} omitted]`,
      ...messages.slice(-side).map(messageLine),
    ],
    included: MAX_INCLUDED_MESSAGES,
    omitted,
  };
}

export default function activate(api) {
  api.on("session_before_compact", (event) => {
    event.signal.throwIfAborted();
    const source = event.plan.sourceMessages;
    const summary = outline(source);
    const instructions = event.customInstructions === undefined
      ? undefined
      : truncate(event.customInstructions.trim(), MAX_INSTRUCTION_BYTES);
    const lines = [
      "# Deterministic compaction checkpoint",
      `Reason: ${event.plan.reason}`,
      ...(instructions ? [`Focus: ${instructions}`] : []),
      "",
      "## Preserved conversation outline",
      ...summary.lines,
    ];
    return {
      compaction: {
        text: lines.join("\n"),
        metadata: {
          strategy: "bounded-role-outline",
          sourceMessages: source.length,
          includedMessages: summary.included,
          omittedMessages: summary.omitted,
        },
      },
    };
  });

  api.on("session_compact", (event) => {
    if (event.fromExtension) api.ui.notify("Custom bounded compaction checkpoint saved.");
  });
}
