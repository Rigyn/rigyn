const MODEL = "reference-offline-v1";
const TOOL = "reference_echo";
const observedAt = "2026-01-01T00:00:00.000Z";
const MAX_STATE_UPDATE_ATTEMPTS = 8;

function state() {
  return {
    kind: "chat_completions",
    assistantMessage: { role: "assistant" },
  };
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
  return "offline package check";
}

function latestToolResult(messages) {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > lastUser; index -= 1) {
    const result = messages[index].content.find(
      (block) => block.type === "tool_result" && block.name === TOOL,
    );
    if (result !== undefined) return result;
  }
  return undefined;
}

export default function activate(api) {
  let eventsSeen = 0;
  let sessionsStarted = 0;
  let callSequence = 0;

  api.registerFlag({
    name: "reference-prefix",
    type: "string",
    default: "reference",
    description: "Prefix returned by the reference echo tool.",
  });

  const prefix = () => {
    const selected = api.getFlag("reference-prefix");
    return typeof selected === "string" && selected.trim() !== ""
      ? selected.trim().slice(0, 64)
      : "reference";
  };

  api.registerTool({
    name: TOOL,
    description: "Echo text through the reference package to verify a runtime tool round trip.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 4096 },
      },
    },
    execute(input) {
      const selectedPrefix = prefix();
      return {
        content: `${selectedPrefix}:${input.text}`,
        isError: false,
        status: "success",
        summary: `Echoed ${input.text.length} character${input.text.length === 1 ? "" : "s"} with prefix ${selectedPrefix}.`,
        nextActions: [],
        metadata: {
          extension: api.extensionId,
          eventsSeen,
          sessionsStarted,
        },
      };
    },
  });

  api.registerToolRenderer(TOOL, {
    renderCall(view, context) {
      const input = view.input !== null && typeof view.input === "object" && !Array.isArray(view.input)
        && typeof view.input.text === "string"
        ? view.input.text
        : "";
      return {
        lines: [{
          spans: [
            { text: context.theme.unicode ? "◆ " : "> ", role: "accent" },
            { text: TOOL, role: "title" },
            ...(input === "" ? [] : [{ text: ` · ${input}`, role: "muted" }]),
          ],
          fill: true,
        }],
      };
    },
    renderResult(view, context) {
      const failed = view.result?.isError === true;
      return {
        lines: [{
          spans: [
            { text: context.theme.unicode ? (failed ? "✗ " : "✓ ") : (failed ? "x " : "ok "), role: failed ? "error" : "success" },
            { text: view.result?.content ?? "", role: failed ? "error" : "assistant" },
          ],
          fill: true,
        }],
      };
    },
  });

  api.session.registerRenderers(1, {
    renderState(entry) {
      const count = entry.value !== null && typeof entry.value === "object" && !Array.isArray(entry.value)
        && typeof entry.value.sessionsStarted === "number"
        ? entry.value.sessionsStarted
        : 0;
      return {
        lines: [{ spans: [
          { text: "Reference lifecycle", role: "title" },
          { text: ` · ${count} session${count === 1 ? "" : "s"} started`, role: "muted" },
        ] }],
      };
    },
    renderMessage(entry) {
      if (entry.transcript === false) return undefined;
      return {
        lines: [{ spans: [
          { text: "Reference", role: "accent" },
          { text: ` · ${entry.transcript.text}`, role: "muted" },
        ] }],
      };
    },
  });

  api.registerCommand({
    name: "reference-demo",
    description: "Run the reference package through its offline model and custom tool.",
    argumentHint: "[text]",
    getArgumentCompletions(argumentPrefix) {
      const options = ["package check", "session check", "renderer check"];
      const normalized = argumentPrefix.trim().toLowerCase();
      return options
        .filter((value) => normalized === "" || value.includes(normalized))
        .map((value) => ({ value, label: value, detail: "Offline reference prompt" }));
    },
    async execute(context) {
      const text = context.args.trim() || "offline package check";
      const target = {
        threadId: context.threadId,
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        signal: context.signal,
      };
      const catalog = await api.getAllTools(target);
      if (!catalog.some((tool) => tool.name === TOOL && tool.owner.kind === "extension")) {
        throw new Error("Reference tool is missing from the executable tool catalog");
      }
      if (!api.getCommands().some((command) => command.baseName === "reference-demo")) {
        throw new Error("Reference command is missing from the runtime command catalog");
      }
      const activeTools = await api.getActiveTools({
        ...target,
      });
      if (!activeTools.includes(TOOL)) {
        await api.setActiveTools({
          ...target,
          names: [...activeTools, TOOL],
        });
      }
      context.ui.setStatus("reference", "demo queued");
      context.ui.setWidget("reference", `Reference demo: ${text}`);
      context.ui.setTitle("Rigyn · Reference demo");
      context.ui.notify("Reference package prepared an offline tool round trip.");
      return { prompt: text };
    },
  });

  api.registerShortcut({
    shortcut: "alt+r",
    description: "Prepare the offline reference prompt.",
    execute(context) {
      context.ui.setEditorText("reference shortcut check");
      context.ui.notify("Reference prompt inserted.");
    },
  });

  api.registerProvider({
    id: "reference-offline",
    async *stream(request, signal) {
      signal.throwIfAborted();
      yield { type: "response_start", model: request.model };
      const tool = request.tools.find((entry) => entry.name === TOOL);
      const result = latestToolResult(request.messages);
      if (tool !== undefined && result === undefined) {
        const text = lastUserText(request.messages).slice(0, 4096) || "offline package check";
        const argumentsValue = JSON.stringify({ text });
        callSequence += 1;
        const callId = `reference-call-${callSequence}`;
        yield { type: "text_delta", part: 0, text: "Checking the reference tool…" };
        yield { type: "tool_call_start", index: 0, id: callId, name: TOOL };
        yield { type: "tool_call_delta", index: 0, jsonFragment: argumentsValue };
        yield {
          type: "tool_call_end",
          index: 0,
          id: callId,
          name: TOOL,
          rawArguments: argumentsValue,
          arguments: { text },
        };
        yield {
          type: "usage",
          usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
          semantics: "final",
        };
        yield { type: "response_end", reason: "tool_calls", state: state() };
        return;
      }

      const reply = result === undefined
        ? `Reference offline model: ${lastUserText(request.messages)}`
        : `Reference offline model completed the tool round trip: ${result.content}`;
      yield { type: "text_delta", part: 0, text: reply };
      yield {
        type: "usage",
        usage: { inputTokens: 12, outputTokens: 10, totalTokens: 22 },
        semantics: "final",
      };
      yield { type: "response_end", reason: "stop", state: state() };
    },
    async listModels(signal) {
      signal.throwIfAborted();
      return [{
        id: MODEL,
        provider: "reference-offline",
        displayName: "Reference Offline",
        contextTokens: 16_384,
        maxOutputTokens: 2_048,
        capabilities: {
          tools: { value: "supported", source: "provider", observedAt },
          reasoning: { value: "unsupported", source: "provider", observedAt },
          images: { value: "unsupported", source: "provider", observedAt },
        },
        metadata: { offline: true },
      }];
    },
  });

  api.ui.setStatus("reference", "offline provider ready");
  api.ui.setWidget("reference", "Reference package active · /reference-demo [text]");
  api.ui.setTitle("Rigyn · Reference package");
  api.ui.notify("Reference package loaded.");

  api.on("session_start", async (event) => {
    const target = {
      threadId: event.threadId,
      ...(event.branch === undefined ? {} : { branch: event.branch }),
    };
    let current = await api.session.readState({
      ...target,
      schemaVersion: 1,
      key: "lifecycle",
    });
    let committed = false;
    for (let attempt = 0; attempt < MAX_STATE_UPDATE_ATTEMPTS; attempt += 1) {
      const previousCount = current?.value !== null
        && typeof current?.value === "object"
        && !Array.isArray(current.value)
        && typeof current.value.sessionsStarted === "number"
        ? current.value.sessionsStarted
        : 0;
      const nextCount = previousCount + 1;
      const result = await api.session.compareAndAppendState({
        ...target,
        schemaVersion: 1,
        key: "lifecycle",
        value: { sessionsStarted: nextCount },
        expectedEventId: current?.eventId ?? null,
      });
      if (result.status === "committed") {
        sessionsStarted = nextCount;
        committed = true;
        break;
      }
      current = result.current;
    }
    if (!committed) throw new Error("Reference lifecycle state changed repeatedly");
    await api.session.appendMessage({
      ...target,
      schemaVersion: 1,
      kind: "session_ready",
      payload: { sessionsStarted },
      modelContext: false,
      transcript: { text: `session ${sessionsStarted} ready` },
    });
  });
  api.on("event", () => {
    eventsSeen += 1;
  });
  api.onDispose(() => {
    eventsSeen = 0;
    sessionsStarted = 0;
  });
}
