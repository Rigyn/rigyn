import { renderFrame, renderTranscript } from "../../src/tui/layout.js";
import { createTheme } from "../../src/tui/theme.js";

const columns = process.stdout.columns ?? 80;
const theme = createTheme("signal", { color: true, unicode: true });
const rendered = renderTranscript([{
  id: "pty-user",
  kind: "user",
  text: "你好🙂 alpha beta\n\nomega",
}], columns, theme, { outputPad: 1 });
const imageOnly = renderTranscript([{
  id: "pty-image-only-user",
  kind: "user",
  text: "",
  images: [{
    key: "pty-image-only-user:image:0",
    block: { type: "image", mediaType: "image/png", data: Buffer.from("fixture").toString("base64") },
  }],
}], columns, theme, { outputPad: 1 });
const tool = renderTranscript([{
  id: "pty-wide-tool",
  kind: "tool",
  title: "bash",
  text: "wide tool output",
  status: "completed",
  toolData: { input: { command: "npm test" } },
}], columns, theme, { outputPad: 1 });
const dock = renderFrame({
  context: {
    status: "executing",
    active: true,
    workspace: `${process.env.HOME ?? "/home/fixture"}/rigyn`,
    sessionName: "renderer check",
    provider: "openai-codex",
    model: "gpt-test",
    thinking: "max",
    thinkingSupported: true,
    contextTokens: 47_200,
    contextWindowTokens: 100_000,
    activity: {
      phase: "Running bash",
      startedAt: Date.now() - 3_100,
      cancellable: true,
    },
  },
  transcript: [],
  transcriptOffset: 0,
  editorText: "",
  editorCursor: 0,
  inputLabel: "you",
  inputMode: "normal",
  usage: {
    total: { inputTokens: 12_400, outputTokens: 860, cacheReadTokens: 9_600 },
    latestCacheHitRate: 91,
  },
}, { columns, rows: 12 }, theme);

process.stdout.write([
  `user-message-start\n${rendered}\nuser-message-end`,
  `image-only-message-start\n${imageOnly}\nimage-only-message-end`,
  `tool-card-start\n${tool}\ntool-card-end`,
  `status-dock-start\n${dock.text}\nstatus-dock-end`,
  "",
].join("\n"));
