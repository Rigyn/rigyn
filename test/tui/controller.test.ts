import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ImageBlock } from "../../src/core/types.js";
import { TuiController, TuiSelectionCancelledError } from "../../src/tui/controller.js";
import { Keybindings } from "../../src/tui/keybindings.js";
import { parseThemeDefinition } from "../../src/tui/theme.js";
import type { TuiAction, TuiInputImageAttachment } from "../../src/tui/types.js";
import { FakeInput, FakeOutput, FakeSignals, envelope, tick } from "./helpers.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForOutput(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function fullController(options: {
  signals?: FakeSignals;
  actions?: TuiAction[];
  alternateScreen?: boolean;
  semanticZones?: boolean;
  terminal?: "kitty" | "iterm2" | "vscode";
  doubleEscapeAction?: "tree" | "fork" | "none";
} = {}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    environment: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      TERM_COLOR: "0",
      ...(options.terminal === "kitty" ? { KITTY_WINDOW_ID: "1" } : {}),
      ...(options.terminal === "iterm2" ? { ITERM_SESSION_ID: "session" } : {}),
      ...(options.terminal === "vscode" ? { TERM_PROGRAM: "vscode" } : {}),
      ...(options.alternateScreen === true ? { RIGYN_ALT_SCREEN: "1" } : {}),
      ...(options.semanticZones === false ? { RIGYN_OSC133: "0" } : {}),
    },
    ...(options.signals === undefined ? {} : { signalSource: options.signals }),
    handleSignals: options.signals !== undefined,
    ...(options.actions === undefined ? {} : { onAction: (action) => { options.actions?.push(action); } }),
    ...(options.doubleEscapeAction === undefined ? {} : { doubleEscapeAction: options.doubleEscapeAction }),
  });
  return { input, output, controller };
}

function png(width = 20, height = 10): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpeg(width = 20, height = 10): Buffer {
  const data = Buffer.alloc(21);
  data.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  data.writeUInt16BE(height, 7);
  data.writeUInt16BE(width, 9);
  return data;
}

function inputImage(label = "clipboard") {
  const data = png(20, 10).toString("base64");
  return {
    block: { type: "image" as const, mediaType: "image/png", data },
    label,
    coordinates: {
      originalWidth: 40,
      originalHeight: 20,
      width: 20,
      height: 10,
      scaleX: 2,
      scaleY: 2,
      orientationApplied: false,
      resized: true,
      converted: false,
    },
  };
}

test("full TUI defaults to an inline surface with raw mode, Unicode editing, and cleanup", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  assert.equal(input.isRaw, true);
  assert.doesNotMatch(output.text, /\u001b\[\?1049h/u);
  assert.match(output.text, /\u001b\[\?2004h/u);
  const answer = controller.question("you> ");
  input.write("he🙂");
  input.write(Buffer.from([127]));
  input.write("llo\r");
  assert.equal(await answer, "hello");
  controller.close();
  assert.deepEqual(input.rawChanges, [true, false]);
  assert.equal(input.isPaused(), true);
  assert.doesNotMatch(output.text, /\u001b\[\?1049l/u);
  assert.match(output.text, /\u001b\[\?2004l/u);
});

test("startup content is present in the first full-screen frame", () => {
  const { output, controller } = fullController();
  controller.setContext({ status: "idle" });
  controller.setStartup("Ready from startup", "Ready from startup");
  assert.ok(output.text.indexOf("Ready from startup") < output.text.indexOf("no-model"));
  controller.close();
});

test("committed startup help can still be revealed with the tool-expansion key", async () => {
  const { input, output, controller } = fullController();
  controller.setStartup("compact startup", "expanded startup resources");
  output.chunks.length = 0;
  input.write(Buffer.from([15]));
  await tick();
  assert.match(output.text, /expanded startup resources/u);
  controller.close();
});

test("run start renders working feedback before the first provider delta", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }));
  await tick();
  assert.match(output.text, /Preparing request/u);
  assert.match(output.text, /Esc cancel/u);
  assert.doesNotMatch(output.text, /provider delta/u);
  controller.close();
});

test("full TUI restores the editor label after a terminal question resolves or aborts", async () => {
  const { input, output, controller } = fullController();
  controller.start();

  const answer = controller.question("Approval required: fixture\n[y] once: ");
  await tick();
  assert.match(output.text, /Approval required: fixture/u);
  output.chunks.length = 0;
  input.write("y\r");
  assert.equal(await answer, "y");
  await tick();
  assert.ok(output.chunks.length > 0);
  assert.doesNotMatch(output.text, /Approval required: fixture/u);

  const cancellation = new AbortController();
  const aborted = controller.question("Temporary question: ", cancellation.signal);
  await tick();
  assert.match(output.text, /Temporary question/u);
  output.chunks.length = 0;
  cancellation.abort(new Error("question cancelled"));
  await assert.rejects(aborted, /question cancelled/u);
  await tick();
  assert.ok(output.chunks.length > 0);
  assert.doesNotMatch(output.text, /Temporary question/u);
  controller.close();
});

test("full TUI keeps the next question alive behind an action picker", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setPickerItems("model", [{
    id: "fixture-model",
    label: "Fixture model",
    value: { provider: "fixture", model: "fixture-model" },
  }]);
  controller.openPicker("model", "Models");

  const answer = controller.question("you> ");
  input.write("\r");
  await tick();
  assert.equal(actions[0]?.type, "select");
  input.write("next prompt\r");
  assert.equal(await answer, "next prompt");
  controller.close();
});

test("full TUI cancels a terminal text question with Escape or Ctrl+C", async () => {
  for (const inputBytes of [Buffer.from([27]), Buffer.from([3])]) {
    const { input, controller } = fullController();
    controller.start();
    const answer = controller.question("Exact model/deployment ID: ");
    input.write(inputBytes);
    await assert.rejects(answer, TuiSelectionCancelledError);
    assert.equal(controller.getEditorText(), "");
    controller.close();
  }
});

test("the primary chat question ignores a lone Escape and still accepts input", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ", undefined, { cancelable: false });
  input.write(Buffer.from([27]));
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  input.write("still here\r");
  assert.equal(await answer, "still here");
  controller.close();
});

test("alternate-screen compatibility remains available by explicit opt-in", async () => {
  const { output, controller } = fullController({ alternateScreen: true });
  controller.start();
  assert.match(output.text, /\u001b\[\?1049h/u);
  await controller.editExternally(async (text) => text);
  assert.equal(output.text.match(/\u001b\[\?1049h/gu)?.length, 2);
  assert.equal(output.text.match(/\u001b\[\?1049l/gu)?.length, 1);
  controller.close();
  assert.equal(output.text.match(/\u001b\[\?1049l/gu)?.length, 2);
});

test("paste-image hotkey emits an app action without inserting text", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  const answer = controller.question("you> ");
  input.write(Buffer.from([22]));
  await tick();
  assert.deepEqual(actions, [{ type: "paste_image" }]);
  input.write("hello\r");
  assert.equal(await answer, "hello");
  controller.close();
});

test("input images remain out of terminal cells and accompany the submitted question", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const attachment = inputImage();
  assert.equal(controller.attachInputImage(attachment), 1);
  await tick();
  assert.match(output.text, /Attachments: clipboard \(image\/png 20x10\)/u);
  assert.doesNotMatch(output.text, new RegExp(attachment.block.data, "u"));
  const answer = controller.question("you> ");
  input.write("inspect this\r");
  assert.equal(await answer, "inspect this");
  assert.deepEqual(controller.takeSubmittedImages(), [attachment]);
  assert.deepEqual(controller.takeSubmittedImages(), []);
  controller.close();
});

test("pending input images follow draft scopes and active steering submissions", async () => {
  const { input, controller } = fullController();
  controller.start();
  controller.setDraftScope("first");
  const attachment = inputImage("first image");
  controller.attachInputImage(attachment);
  controller.setEditorText("first draft");
  controller.setDraftScope("second");
  controller.setEditorText("second draft");
  controller.setDraftScope("first");
  let steered: { line: string; images?: readonly TuiInputImageAttachment[] } | undefined;
  controller.setSteering((line, images) => {
    steered = { line, ...(images === undefined ? {} : { images }) };
  });
  input.write("\r");
  await tick();
  assert.equal(steered?.line, "first draft");
  assert.deepEqual(steered?.images, [attachment]);
  controller.close();
});

test("inline transcript semantic zones are stable and can be disabled", async () => {
  const renderUser = async (semanticZones: boolean) => {
    const { output, controller } = fullController({ semanticZones });
    controller.start();
    output.chunks.length = 0;
    controller.render(envelope({
      type: "message_appended",
      message: {
        id: semanticZones ? "zones-on" : "zones-off",
        role: "user",
        content: [{ type: "text", text: "stable message" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }));
    await tick();
    const text = output.text;
    controller.close();
    return text;
  };
  const enabled = await renderUser(true);
  assert.match(enabled, /\u001b\]133;A\u0007/u);
  assert.match(enabled, /\u001b\]133;B\u0007\u001b\]133;C\u0007/u);
  assert.match(enabled, /stable message/u);
  const disabled = await renderUser(false);
  assert.doesNotMatch(disabled, /\u001b\]133;/u);
  assert.match(disabled, /stable message/u);
});

test("inline transcript sends validated images through the trusted Kitty channel", async () => {
  const { output, controller } = fullController({ terminal: "kitty" });
  const data = png().toString("base64");
  controller.start();
  output.chunks.length = 0;
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "kitty-user-image",
      role: "user",
      content: [
        { type: "text", text: "terminal image" },
        { type: "image", mediaType: "image/png", data },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  await tick();
  assert.match(output.text, /\[Image: image\/png 20x10\]/u);
  assert.match(output.text, /\u001b_Ga=T,f=100,q=2,C=1/u);
  assert.match(output.text, new RegExp(data.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  controller.close();
});

test("canonical tool-result images join their lifecycle card without exposing base64 as text", async () => {
  const { output, controller } = fullController({ terminal: "kitty" });
  const data = png(12, 8).toString("base64");
  controller.start();
  output.chunks.length = 0;
  controller.render(envelope({
    type: "tool_completed",
    callId: "read-terminal-image",
    name: "read",
    index: 0,
    isError: false,
    preview: "read image",
    result: {
      type: "tool_result",
      callId: "read-terminal-image",
      name: "read",
      content: "read image",
      isError: false,
      images: [{ type: "image", mediaType: "image/png", data }],
    },
  }, 1));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "tool-terminal-image",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "read-terminal-image",
        name: "read",
        content: "read image",
        isError: false,
        images: [{ type: "image", mediaType: "image/png", data }],
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 2));
  await tick();
  assert.match(output.text, /read image/u);
  assert.match(output.text, /\[Image: image\/png 12x8\]/u);
  assert.match(output.text, /\u001b_Ga=T,f=100/u);
  assert.equal(output.text.split(data).length - 1, 1);
  controller.close();
});

test("iTerm transcript previews retain native JPEG content and bounded cell geometry", async () => {
  const { output, controller } = fullController({ terminal: "iterm2" });
  const data = jpeg(30, 20).toString("base64");
  controller.start();
  output.chunks.length = 0;
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "iterm-user-image",
      role: "user",
      content: [{ type: "image", mediaType: "image/jpeg", data }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  await tick();
  assert.match(output.text, /\[Image: image\/jpeg 30x20\]/u);
  assert.match(output.text, /\u001b\]1337;File=inline=1;size=21;width=\d+;height=\d+;preserveAspectRatio=1:/u);
  assert.equal(output.text.split(data).length - 1, 1);
  controller.close();
});

test("unsupported and accessibility terminals retain image captions without exposing URLs", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "accessible",
    handleSignals: false,
    environment: { TERM: "dumb" },
  });
  controller.start();
  output.chunks.length = 0;
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "remote-image",
      role: "user",
      content: [{ type: "image", mediaType: "image/png", url: "https://secret.example.test/image.png?token=private" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  await tick();
  assert.match(output.text, /\[Image: image\/png\]/u);
  assert.doesNotMatch(output.text, /secret\.example|token=private|\u001b/u);
  controller.close();
});

test("known OSC 8 terminals link host-parsed Markdown and unknown terminals keep literal URLs", async () => {
  const render = async (terminal: "vscode" | undefined) => {
    const { output, controller } = fullController({ ...(terminal === undefined ? {} : { terminal }) });
    controller.start();
    output.chunks.length = 0;
    controller.render(envelope({
      type: "message_appended",
      message: {
        id: `assistant-link-${terminal ?? "unknown"}`,
        role: "assistant",
        content: [{ type: "text", text: "Read [docs](https://example.test/guide)" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }));
    await tick();
    const text = output.text;
    controller.close();
    return text;
  };
  assert.match(await render("vscode"), /\u001b\]8;;https:\/\/example\.test\/guide\u001b\\docs\u001b\]8;;\u001b\\/u);
  const fallback = await render(undefined);
  assert.match(fallback, /\[docs\]\(https:\/\/example\.test\/guide\)/u);
  assert.doesNotMatch(fallback, /\u001b\]8;/u);
});

test("full TUI negotiates Kitty keyboard input from a fragmented reply and restores it", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  assert.match(output.text, /\u001b\[\?u\u001b\[c/u);
  output.chunks.length = 0;
  input.write("\u001b[?");
  input.write("7u");
  await tick();
  assert.match(output.text, /\u001b\[>7u/u);

  const answer = controller.question("you> ");
  input.write("\u001b[13;1:3u");
  input.write("\u001b[104;1u\u001b[105;1u\u001b[13;1:1u");
  assert.equal(await answer, "hi");
  controller.close();
  assert.match(output.text, /\u001b\[<u/u);
  assert.ok(output.text.indexOf("\u001b[<u") < output.text.lastIndexOf("\u001b[?2004l"));
});

test("full TUI falls back to modify-other-keys and can upgrade after a late Kitty reply", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  input.write("\u001b[?1;");
  input.write("2c");
  await tick();
  assert.match(output.text, /\u001b\[>4;2m/u);

  output.chunks.length = 0;
  input.write("\u001b[?3u");
  await tick();
  assert.match(output.text, /\u001b\[>4m\u001b\[>7u/u);
  controller.close();
  assert.match(output.text, /\u001b\[<u/u);
});

test("enhanced keyboard input drains late releases before shutdown", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  input.write("\u001b[?7u");
  await tick();
  output.chunks.length = 0;
  const drain = controller.drainInput(250, 30);
  setTimeout(() => input.write("discarded"), 10);
  setTimeout(() => input.write("\u001b[13;1:3u"), 20);
  await drain;
  assert.match(output.text, /\u001b\[<u/u);
  const answer = controller.question("you> ");
  input.write("kept\r");
  assert.equal(await answer, "kept");
  controller.close();
});

test("suspend restores cooked mode and redraws after SIGCONT", {
  skip: process.platform === "win32",
}, async () => {
  const signals = new FakeSignals();
  const { input, output, controller } = fullController({ signals });
  controller.start();
  input.write("\u001b[?7u");
  await tick();
  output.chunks.length = 0;
  let stopped = false;
  controller.suspend(() => { stopped = true; });
  assert.equal(stopped, true);
  assert.equal(input.isRaw, false);
  assert.match(output.text, /\u001b\[<u.*\u001b\[\?2004l/us);
  output.chunks.length = 0;
  signals.signal("SIGCONT");
  await tick();
  assert.equal(input.isRaw, true);
  assert.match(output.text, /\u001b\[\?2004h.*\u001b\[\?u\u001b\[c/us);
  controller.close();
});

test("external-editor suspension restores enhanced input before returning to canonical mode", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  input.write("\u001b[?7u");
  await tick();
  output.chunks.length = 0;
  await controller.editExternally(async (text) => text);
  const pop = output.text.indexOf("\u001b[<u");
  const pasteOff = output.text.indexOf("\u001b[?2004l");
  const pasteOn = output.text.lastIndexOf("\u001b[?2004h");
  const query = output.text.lastIndexOf("\u001b[?u\u001b[c");
  assert.ok(pop >= 0 && pop < pasteOff);
  assert.ok(pasteOff < pasteOn && pasteOn < query);
  controller.close();
});

test("full TUI uses a bounded negotiation deadline when a terminal does not reply", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.match(output.text, /\u001b\[>4;2m/u);
  controller.close();
  assert.match(output.text, /\u001b\[>4m/u);
});

test("full TUI hides secret input and resumes normal questions", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const secret = controller.readSecret("API key: ");
  input.write("never-render-this-key\r");
  assert.equal(await secret, "never-render-this-key");
  assert.doesNotMatch(output.text, /never-render-this-key/u);
  assert.ok(output.text.indexOf("\u001b[?2004l") < output.text.indexOf("API key: "));
  assert.match(output.text.slice(output.text.indexOf("API key: ")), /\u001b\[\?2004h/u);
  const answer = controller.question("you> ");
  input.write("ready\r");
  assert.equal(await answer, "ready");
  controller.close();
});

test("terminal clipboard copy emits only a bounded OSC 52 payload", () => {
  const { output, controller } = fullController();
  controller.start();
  controller.copyToClipboard("copy me");
  assert.match(output.text, /\u001b\]52;c;Y29weSBtZQ==\u0007/u);
  assert.throws(() => controller.copyToClipboard("x".repeat(100 * 1024 + 1)), /100 KiB/u);
  controller.close();
});

test("TUI secret input is not echoed by a real PTY", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-secret.ts", import.meta.url));
  const command = [process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });

  await waitForOutput(() => rendered, "API key: ");
  child.stdin.write("tui-secret-never-render\n");
  await waitForOutput(() => rendered, "Continue: ");
  child.stdin.write("yes\n");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.doesNotMatch(rendered, /tui-secret-never-render/u);
  assert.match(rendered, /tui-secret-complete/u);
});

test("real PTY paste-image hotkey attaches metadata without echoing payload bytes", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-clipboard-attachment.ts", import.meta.url));
  const command = `stty cols 64 rows 12; TERM=xterm-256color NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  await waitForOutput(() => rendered, "Clipboard prompt");
  child.stdin.write(Buffer.from([22]));
  await waitForOutput(() => rendered, "Attachments: clipboard-pty (image/png 12x8)");
  child.stdin.write("inspect\r");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const base64 = png(12, 8).toString("base64");
  const digest = createHash("sha256").update(png(12, 8)).digest("hex").slice(0, 12);
  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, new RegExp(`clipboard-pty:inspect:1:${digest}`, "u"));
  assert.doesNotMatch(rendered, new RegExp(base64, "u"));
  assert.doesNotMatch(rendered, /clipboard-pty-error/u);
});

test("inline PTY commits completed rows beyond the viewport without erasing or duplicating them", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-inline-scrollback.ts", import.meta.url));
  const command = `stty cols 48 rows 8; TERM=xterm-256color NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["ignore", "pipe", "pipe"] });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.doesNotMatch(rendered, /\u001b\[\?1049[hl]/u);
  assert.match(rendered, /inline-scrollback-complete/u);
  assert.ok(rendered.indexOf("scroll-user-00") < rendered.indexOf("scroll-user-29"));
  assert.equal(rendered.split("scroll-user-00").length - 1, 1);
  assert.equal(rendered.split("scroll-agent-00").length - 1, 1);
  assert.equal(rendered.split("scroll-user-29").length - 1, 1);
  assert.doesNotMatch(
    rendered.slice(rendered.indexOf("scroll-user-00")),
    /\u001b\[(?:[4-9]|[1-9][0-9]+)A\u001b\[J/u,
  );
});

test("real PTY differentially grows and shrinks the live surface without clearing scrollback", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-row-diff.ts", import.meta.url));
  const command = `stty cols 48 rows 8; TERM=xterm-256color NO_COLOR=1 RIGYN_SYNC_UPDATE=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["ignore", "pipe", "pipe"] });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, /row-diff-pty-complete/u);
  assert.equal(rendered.split("row-diff-committed").length - 1, 1);
  assert.match(rendered, /surface-initial/u);
  assert.match(rendered, /surface-expanded-2/u);
  assert.match(rendered, /surface-shrunk/u);
  assert.doesNotMatch(rendered, /\u001b\[(?:3J|\?1049[hl])/u);
  const starts = rendered.match(/\u001b\[\?2026h/gu)?.length ?? 0;
  const ends = rendered.match(/\u001b\[\?2026l/gu)?.length ?? 0;
  assert.ok(starts >= 3, rendered);
  assert.equal(ends, starts);
});

test("real PTY keeps image payloads inside the bounded Kitty protocol channel", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-terminal-image.ts", import.meta.url));
  const command = `stty cols 48 rows 12; TERM=xterm-256color KITTY_WINDOW_ID=1 NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["ignore", "pipe", "pipe"] });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const data = png().toString("base64");
  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, /terminal-image-pty-caption/u);
  assert.match(rendered, /\u001b_Ga=T,f=100,q=2,C=1/u);
  assert.equal(rendered.split(data).length - 1, 1);
  assert.match(rendered, /terminal-image-pty-complete/u);
  assert.doesNotMatch(rendered, /\u001b\[3J/u);
});

test("real PTY accepts fragmented Kitty replies, filters releases, and restores keyboard mode", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-keyboard.ts", import.meta.url));
  const command = `TERM=xterm-256color NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });

  await waitForOutput(() => rendered, "\u001b[?u\u001b[c");
  child.stdin.write("\u001b[?");
  child.stdin.write("7u");
  await waitForOutput(() => rendered, "\u001b[>7u");
  child.stdin.write("\u001b[104;1u\u001b[105;1u\u001b[13;1:3u\u001b[13;1:1u");
  await waitForOutput(() => rendered, "keyboard-pty:hi");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.match(rendered, /\u001b\[>7u/u);
  assert.match(rendered, /\u001b\[<u/u);
  assert.doesNotMatch(rendered, /keyboard-pty-timeout|keyboard-pty-error/u);
});

test("large bracketed paste renders only a marker and expands at submission", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const payload = Array.from({ length: 12 }, (_, index) => `controller-private-${index}`).join("\n");
  const answer = controller.question("you> ");
  output.chunks.length = 0;
  input.write(`\u001b[200~${payload}\u001b[201~`);
  await tick();
  assert.match(output.text, /\[paste #1 \+12 lines\]/u);
  assert.doesNotMatch(output.text, /controller-private-/u);
  input.write("\r");
  assert.equal(await answer, payload);
  controller.close();
});

test("large-paste payload survives draft scopes and marker-preserving external edits", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setDraftScope("one");
  const payload = Array.from({ length: 11 }, (_, index) => `scope-private-${index}`).join("\n");
  const answer = controller.question("you> ");
  input.write(`\u001b[200~${payload}\u001b[201~`);
  controller.setDraftScope("two");
  controller.setDraftScope("one");
  await controller.editExternally(async (text) => `before ${text} after`);
  await tick();
  assert.match(output.text, /before \[paste #1 \+11 lines\] after/u);
  assert.doesNotMatch(output.text, /scope-private-/u);
  input.write("\r");
  assert.equal(await answer, `before ${payload} after`);
  controller.close();
});

test("real PTY never echoes a large paste payload while preserving its submitted digest", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/tui-large-paste.ts", import.meta.url));
  const command = `TERM=xterm-256color NO_COLOR=1 ${[process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  const payload = Array.from({ length: 12 }, (_, index) => `pty-private-${index}`).join("\n");
  const digest = createHash("sha256").update(payload).digest("hex");

  await waitForOutput(() => rendered, "\u001b[?u\u001b[c");
  child.stdin.write(`\u001b[200~${payload}\u001b[201~`);
  await waitForOutput(() => rendered, "[paste #1 +12 lines]");
  assert.doesNotMatch(rendered, /pty-private-/u);
  child.stdin.write("\r");
  await waitForOutput(() => rendered, `paste-pty:${Buffer.byteLength(payload)}:${digest}`);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.doesNotMatch(rendered, /pty-private-|paste-pty-timeout|paste-pty-error/u);
});

test("controller exposes jump, kill, yank, and yank-pop editing defaults", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("hello world");
  input.write(Buffer.from([1]));
  input.write(Buffer.from([29]));
  input.write("o");
  input.write("X");
  input.write(Buffer.from([11]));
  input.write(Buffer.from([25]));
  input.write("\r");
  assert.equal(await answer, "hellXo world");
  controller.close();
});

test("controller dispatches remapped kill, yank, and yank-pop actions", async () => {
  const { input, controller } = fullController();
  controller.setKeybindings(new Keybindings({
    "tui.editor.deleteToLineEnd": "alt+k",
    "tui.editor.yank": "alt+p",
    "tui.editor.yankPop": "alt+n",
  }));
  controller.start();
  const answer = controller.question("you> ");
  input.write("first");
  input.write(Buffer.from([1]));
  input.write("\u001bk");
  assert.equal(controller.getEditorText(), "");
  input.write("second");
  input.write(Buffer.from([1]));
  input.write("\u001bk");
  assert.equal(controller.getEditorText(), "");
  input.write("\u001bp");
  assert.equal(controller.getEditorText(), "second");
  input.write("\u001bn");
  assert.equal(controller.getEditorText(), "first");
  input.write("\r");
  assert.equal(await answer, "first");
  controller.close();
});

test("PageUp moves within a multiline editor viewport before paging transcript", async () => {
  const { input, controller } = fullController();
  controller.start();
  const lines = Array.from({ length: 8 }, (_, index) => String(index));
  controller.setEditorText(lines.join("\n"));
  const answer = controller.question("you> ");
  input.write("\u001b[5~");
  input.write("X\r");
  lines[2] = "2X";
  assert.equal(await answer, lines.join("\n"));
  controller.close();
});

test("drafts survive picker use and session-scope switches", async () => {
  const { input, controller } = fullController();
  controller.start();
  controller.setDraftScope("one");
  input.write("alpha draft");
  const selection = controller.choose("Models", [
    { label: "small", value: "small" },
    { label: "beta smart", value: "smart" },
  ]);
  input.write("beta\r");
  assert.equal(await selection, "smart");
  controller.setDraftScope("two");
  input.write("other draft");
  controller.setDraftScope("one");
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "alpha draft");
  controller.close();
});

test("cancelling a picker is a typed user action", async () => {
  const { input, controller } = fullController();
  controller.start();
  const selection = controller.choose("Models", [{ label: "small", value: "small" }]);
  input.write(Buffer.from([3]));
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});

test("an empty session picker remains usable and explains all-workspace recovery", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const selection = controller.choosePicker("session", "Resume Session", []);
  await tick();
  assert.match(output.text, /No sessions in this workspace/u);
  assert.match(output.text, /\/resume --all searches every indexed workspace/u);
  input.write("\u001b");
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});

test("the combined-model picker preserves the draft", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setPickerItems("model", [
    { id: "openai/gpt", label: "openai / gpt", value: { provider: "openai", model: "gpt" } },
    { id: "anthropic/claude", label: "anthropic / claude", value: { provider: "anthropic", model: "claude" } },
  ]);
  input.write("keep me");
  input.write(Buffer.from([12]));
  input.write("claude\r");
  assert.equal(actions[0]?.type, "select");
  if (actions[0]?.type === "select") {
    assert.equal(actions[0].picker, "model");
    assert.deepEqual(actions[0].item.value, { provider: "anthropic", model: "claude" });
  }
  assert.equal(actions.length, 1);
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "keep me");
  controller.close();
});

test("an empty model picker explains that authentication lives under /login", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setPickerItems("model", []);
  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /No available models\. Use \/login to connect a provider\./u);
  input.write("\u001b");
  controller.close();
});

test("an empty connected model picker reports catalog recovery instead of asking for login", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setPickerItems("model", []);
  controller.setModelPickerEmptyMessage("Connected provider catalogs are unavailable: corp (network). Retry /model or /reload.");
  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /Connected provider catalogs are unavailable: corp \(network\)/u);
  assert.match(output.text, /Retry \/model/u);
  assert.match(output.text, /\/reload\./u);
  assert.doesNotMatch(output.text, /Use \/login to connect/u);
  input.write("\u001b");
  controller.close();
});

test("a refreshing model picker retains live rows and never misdiagnoses loading as missing authentication", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setModelPickerItems([
    { id: "openai/gpt", label: "openai / gpt", value: { provider: "openai", model: "gpt" } },
  ]);
  controller.setModelPickerLoading(true);
  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /Refreshing live available models/u);
  assert.match(output.text, /gpt \[openai\]/u);
  assert.doesNotMatch(output.text, /Use \/login/u);

  controller.addModelPickerItems([
    { id: "anthropic/claude", label: "anthropic / claude", value: { provider: "anthropic", model: "claude" } },
  ]);
  await tick();
  assert.match(output.text, /claude \[anthropic\]/u);
  controller.close();
});

test("an initially empty refreshing picker shows an explicit loading state", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setModelPickerLoading(true);
  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /Loading live available models/u);
  assert.doesNotMatch(output.text, /Use \/login/u);
  controller.close();
});

test("model picker opens on the scoped set and Tab toggles the same overlay to all models", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const alpha = { id: "p/alpha", label: "p / alpha", value: { provider: "p", model: "alpha" } };
  const beta = { id: "p/beta", label: "p / beta", value: { provider: "p", model: "beta" } };
  controller.setModelPickerItems([alpha, beta], [beta]);
  output.chunks.length = 0;
  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /beta \[p\]/u);
  assert.doesNotMatch(output.text, /alpha \[p\]/u);
  output.chunks.length = 0;
  input.write("\t");
  await tick();
  assert.match(output.text, /alpha \[p\]/u);
  assert.doesNotMatch(output.text, /Use \/login/u);
  controller.close();
});

test("model picker shows provider badges, marks the active model, and wraps arrow navigation", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.start();
  controller.setContext({ provider: "openai", model: "alpha" });
  controller.setPickerItems("model", [
    { id: "openai/alpha", label: "openai / alpha", value: { provider: "openai", model: "alpha" } },
    { id: "anthropic/beta", label: "anthropic / beta", value: { provider: "anthropic", model: "beta" } },
  ]);

  input.write(Buffer.from([12]));
  await tick();
  assert.match(output.text, /alpha \[openai\] ✓/u);
  assert.match(output.text, /beta \[anthropic\]/u);
  assert.doesNotMatch(output.text, /beta \[anthropic\] ✓/u);

  input.write("\u001b[A\r");
  assert.equal(actions[0]?.type, "select");
  if (actions[0]?.type === "select") assert.deepEqual(actions[0].item.value, { provider: "anthropic", model: "beta" });

  input.write(Buffer.from([12]));
  input.write("\u001b[B\u001b[B\r");
  assert.equal(actions[1]?.type, "select");
  if (actions[1]?.type === "select") assert.deepEqual(actions[1].item.value, { provider: "openai", model: "alpha" });
  controller.close();
});

test("scoped-model picker searches, toggles exact models, saves, and preserves the draft", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  input.write("keep this draft");
  const selection = controller.chooseScopedModels([
    { id: "p/alpha", label: "p / alpha", value: { provider: "p", model: "alpha" } },
    { id: "p/beta", label: "p / beta", value: { provider: "p", model: "beta" } },
    { id: "q/gamma", label: "q / gamma", value: { provider: "q", model: "gamma" } },
  ], { all: false, selected: [] });
  await tick();
  assert.match(output.text, /Scoped Models/u);
  assert.match(output.text, /Ctrl\+A all · Ctrl\+X none · Ctrl\+S save/u);
  input.write("beta\r");
  await tick();
  assert.match(output.text, /☑ p \/ beta/u);
  input.write(Buffer.from([19]));
  assert.deepEqual(await selection, { mode: "models", patterns: ["p/beta"] });
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "keep this draft");
  controller.close();
});

test("scoped-model picker supports provider/all/none controls, save row, and typed cancel", async () => {
  const { input, controller } = fullController();
  controller.start();
  const models = [
    { id: "p/alpha", label: "p / alpha", value: { provider: "p", model: "alpha" } },
    { id: "p/beta", label: "p / beta", value: { provider: "p", model: "beta" } },
    { id: "q/gamma", label: "q / gamma", value: { provider: "q", model: "gamma" } },
  ];

  const provider = controller.chooseScopedModels(models, { all: false, selected: ["p/alpha"] });
  input.write("alpha");
  input.write(Buffer.from([16]));
  input.write(Buffer.from([19]));
  assert.deepEqual(await provider, { mode: "models", patterns: ["p/alpha", "p/beta"] });

  const all = controller.chooseScopedModels(models, { all: false, selected: [] });
  input.write(Buffer.from([1, 19]));
  assert.deepEqual(await all, { mode: "all" });

  const none = controller.chooseScopedModels(models, { all: true, selected: [] });
  input.write(Buffer.from([24, 19]));
  assert.deepEqual(await none, { mode: "none" });

  const saveRow = controller.chooseScopedModels(models, { all: false, selected: [] });
  input.write("\r");
  assert.deepEqual(await saveRow, { mode: "none" });

  const cancelled = controller.chooseScopedModels(models, { all: true, selected: [] });
  input.write(Buffer.from([27]));
  await assert.rejects(cancelled, TuiSelectionCancelledError);
  controller.close();
});

test("live scoped-model changes apply immediately and save without closing the picker", async () => {
  const changes: unknown[] = [];
  const saves: unknown[] = [];
  const { input, output, controller } = fullController();
  controller.start();
  const selection = controller.chooseScopedModels([
    { id: "p/alpha", label: "p / alpha", value: { provider: "p", model: "alpha" } },
    { id: "p/beta", label: "p / beta", value: { provider: "p", model: "beta" } },
  ], {
    all: false,
    selected: ["p/alpha"],
    live: true,
    onChange: (value) => changes.push(value),
    onSave: (value) => { saves.push(value); },
  });
  input.write("beta\r");
  assert.deepEqual(changes, [{ mode: "models", patterns: ["p/alpha", "p/beta"] }]);
  input.write(Buffer.from([19]));
  await tick();
  assert.deepEqual(saves, [{ mode: "models", patterns: ["p/alpha", "p/beta"] }]);
  assert.match(output.text, /Saved model cycling defaults/u);
  assert.match(output.text, /Scoped Models/u);
  input.write(Buffer.from([27]));
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});

test("scoped-model picker reorders an ordered draft with remappable keys", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setKeybindings(new Keybindings({
    "app.models.reorderUp": "ctrl+k",
    "app.models.reorderDown": "ctrl+n",
  }));
  const selection = controller.chooseScopedModels([
    { id: "p/alpha", label: "p / alpha", value: { provider: "p", model: "alpha" } },
    { id: "p/beta", label: "p / beta", value: { provider: "p", model: "beta" } },
    { id: "q/gamma", label: "q / gamma", value: { provider: "q", model: "gamma" } },
  ], { all: false, selected: ["q/gamma", "p/alpha", "p/beta"] });
  await tick();
  assert.match(output.text, /Ctrl\+K\/Ctrl\+N reorder/u);
  input.write("alpha");
  input.write(Buffer.from([11]));
  await tick();
  assert.match(output.text, /Moved p\/alpha up/u);
  input.write(Buffer.from([19]));
  assert.deepEqual(await selection, { mode: "models", patterns: ["p/alpha", "q/gamma", "p/beta"] });
  controller.close();
});

test("model cycling uses its dedicated order and handles a current model outside scope", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setPickerItems("model", [
    { id: "manual", label: "manual", value: { provider: "p", model: "manual" } },
  ]);
  controller.setModelCycleItems([
    { id: "beta", label: "beta", value: { provider: "p", model: "beta" } },
    { id: "alpha", label: "alpha", value: { provider: "p", model: "alpha" } },
    { id: "gamma", label: "gamma", value: { provider: "p", model: "gamma" } },
    { id: "gamma-duplicate", label: "duplicate", value: { provider: "p", model: "gamma" } },
  ]);
  controller.setContext({ provider: "p", model: "alpha" });
  input.write(Buffer.from([16]));
  controller.setContext({ provider: "p", model: "outside" });
  input.write("\u001b[112;6u");
  await tick();
  assert.equal(actions[0]?.type, "select");
  assert.equal(actions[1]?.type, "select");
  if (actions[0]?.type === "select") assert.deepEqual(actions[0].item.value, { provider: "p", model: "gamma" });
  if (actions[1]?.type === "select") assert.deepEqual(actions[1].item.value, { provider: "p", model: "gamma" });
  controller.close();
});

test("model cycling with one scoped model is a no-op with a clear status", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.start();
  controller.setContext({ provider: "p", model: "only" });
  controller.setModelCycleItems([
    { id: "only", label: "only", value: { provider: "p", model: "only" } },
  ]);
  output.chunks.length = 0;
  input.write(Buffer.from([16]));
  await tick();
  assert.deepEqual(actions, []);
  assert.match(output.text, /Only one model in scope/u);
  controller.close();
});

test("session-tree picker folds, toggles paths, cycles sibling endpoints, and preserves the draft", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  input.write("draft survives");
  const rows = [
    { id: "root", label: "Root prompt", value: "root", tree: { eventId: "root", kind: "user", depth: 0, prefix: "└─ ", branches: [], paths: ["main", "sibling"], active: true } },
    { id: "main", label: "Main prompt", value: "main", tree: { eventId: "main", kind: "user", depth: 1, prefix: "   ├─ ", branches: ["main"], paths: ["main"], active: true } },
    { id: "sibling", label: "Sibling prompt", value: "sibling", tree: { eventId: "sibling", kind: "user", depth: 1, prefix: "   └─ ", branches: ["sibling"], paths: ["sibling"], active: false } },
  ];
  const selection = controller.chooseSessionTree("Session Tree", rows);
  await tick();
  assert.match(output.text, /Ctrl\+← \/ Alt\+← fold\/previous endpoint/u);

  input.write("\u001b[A");
  input.write("\u001b[1;5D");
  await tick();
  assert.match(output.text, /Folded root/u);
  input.write("\u001b[1;5C");
  await tick();
  assert.match(output.text, /Unfolded root/u);

  input.write(Buffer.from([16]));
  await tick();
  assert.match(output.text, /Session Tree · default · Active path/u);
  input.write(Buffer.from([16]));
  input.write("\u001b[1;5C\u001b[1;5C");
  input.write("\r");
  assert.equal(await selection, "sibling");

  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "draft survives");

  const cancelled = controller.chooseSessionTree("Session Tree", rows);
  input.write(Buffer.from([27]));
  await assert.rejects(cancelled, TuiSelectionCancelledError);
  controller.close();
});

test("session-tree help follows remapped tree actions", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.setKeybindings(new Keybindings({
    "app.tree.foldOrPreviousEndpoint": "alt+h",
    "app.tree.unfoldOrNextEndpoint": "alt+l",
    "app.tree.togglePath": "alt+a",
  }));
  controller.start();
  const selection = controller.chooseSessionTree("Session Tree", [{
    id: "root",
    label: "Root prompt",
    value: { text: "Root prompt text" },
    tree: { eventId: "root", kind: "user", depth: 0, prefix: "└─ ", branches: ["main"], paths: ["main"], active: true },
  }]);
  await tick();
  assert.match(output.text, /Alt\+H fold\/previous endpoint · Alt\+L unfold\/next/u);
  assert.match(output.text, /Alt\+A active\/all/u);
  assert.match(output.text, /Ctrl\+X copy/u);
  input.write(Buffer.from([24]));
  await tick();
  assert.deepEqual(actions, [{ type: "copy_text", text: "Root prompt text", label: "selected tree entry" }]);
  input.write(Buffer.from([27]));
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});

test("session-tree labels, timestamps, and filters remain interactive without selecting an entry", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const changes: Array<{ eventId: string; label?: string }> = [];
  const selection = controller.chooseSessionTree("Session Tree", [
    { id: "user", label: "User prompt", value: "user", tree: { eventId: "user", kind: "user", depth: 0, prefix: "└─ ", branches: [], paths: ["main"], active: true } },
    { id: "assistant", label: "Assistant answer", value: "assistant", tree: { eventId: "assistant", kind: "assistant", depth: 1, prefix: "   ├─ ", branches: [], paths: ["main"], active: true } },
    { id: "tool", label: "Tool output", value: "tool", tree: { eventId: "tool", kind: "tool", depth: 1, prefix: "   └─ ", branches: ["main"], paths: ["main"], active: true } },
  ], {
    onLabelChange(eventId, label) {
      changes.push({ eventId, ...(label === undefined ? {} : { label }) });
      return label === undefined ? {} : { label, labelTimestamp: "2026-07-10T12:34:56.000Z" };
    },
  });
  input.write(Buffer.from([21]));
  await tick();
  assert.match(output.text, /Filter: user-only/u);
  input.write("L");
  await tick();
  assert.match(output.text, /Add entry label/u);
  input.write("bookmark\r");
  await tick();
  assert.deepEqual(changes, [{ eventId: "user", label: "bookmark" }]);
  assert.match(output.text, /Labeled user: bookmark/u);

  input.write(Buffer.from([12]));
  input.write("T");
  await tick();
  assert.match(output.text, /Session Tree · labeled-only · All paths/u);
  assert.match(output.text, /\[bookmark\] 2026-07-10 12:34 User prompt/u);
  input.write("L");
  input.write(Buffer.from([21]));
  input.write("\r");
  await tick();
  assert.deepEqual(changes.at(-1), { eventId: "user" });
  assert.match(output.text, /No matching tree entries/u);

  input.write(Buffer.from([15]));
  await tick();
  assert.match(output.text, /Filter: all/u);
  input.write(Buffer.from([27]));
  await assert.rejects(selection, TuiSelectionCancelledError);
  controller.close();
});

test("an exact command picker match submits on the first Enter", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("/");
  input.write("exit\r");
  assert.equal(await answer, "/exit");
  controller.close();
});

test("a partial command picker selection submits on the first Enter", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("/");
  input.write("ex\r");
  assert.equal(await answer, "/export");
  controller.close();
});

test("command picker preserves arguments and submits an unmatched slash command", async () => {
  const first = fullController();
  first.controller.start();
  first.controller.addPickerItems("command", [{
    id: "runtime-command:reference-demo",
    label: "/reference-demo",
    value: "/reference-demo",
  }]);
  const command = first.controller.question("you> ");
  first.input.write("/");
  first.input.write("reference-demo interactive-check");
  first.input.write("\r");
  assert.equal(await command, "/reference-demo interactive-check");
  first.controller.close();

  const second = fullController();
  second.controller.start();
  const unmatched = second.controller.question("you> ");
  second.input.write("/");
  second.input.write("not-a-command\r");
  assert.equal(await unmatched, "/not-a-command");
  second.controller.close();
});

test("argument-taking default commands remain available in command completion", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("/");
  input.write("export session.jsonl");
  input.write("\r");
  assert.equal(await answer, "/export session.jsonl");
  controller.close();
});

test("async command argument completion applies only to the unchanged editor snapshot", async () => {
  const { input, controller } = fullController();
  const generation = new AbortController();
  let finish!: (value: readonly { value: string }[]) => void;
  controller.start();
  controller.setCommandItems([{ id: "deploy", label: "/deploy", value: "/deploy" }]);
  controller.setCommandCompletionProvider(async () => await new Promise((resolve) => { finish = resolve; }), generation.signal);
  input.write("/deploy d\t");
  await tick();
  input.write("x");
  finish([{ value: "dev" }]);
  await tick();
  assert.equal(controller.getEditorText(), "/deploy dx");
  generation.abort();
  controller.close();
});

test("command completions are generation-owned and malformed providers cannot mutate input", async () => {
  const { input, output, controller } = fullController();
  const stale = new AbortController();
  let finish!: (value: readonly { value: string }[]) => void;
  controller.start();
  controller.setCommandItems([{ id: "deploy", label: "/deploy", value: "/deploy" }]);
  controller.setCommandCompletionProvider(async () => await new Promise((resolve) => { finish = resolve; }), stale.signal);
  input.write("/deploy d\t");
  await tick();
  stale.abort(new Error("runtime reloaded"));
  finish([{ value: "stale" }]);
  await tick();
  assert.equal(controller.getEditorText(), "/deploy d");

  const current = new AbortController();
  controller.setCommandCompletionProvider(async () => [{ value: "bad\0value" }], current.signal);
  input.write("\t");
  await tick();
  assert.equal(controller.getEditorText(), "/deploy d");
  assert.match(output.text, /Command completion failed/u);
  current.abort();
  controller.close();
});

test("classic command completion exposes bounded choices without requiring the full TUI", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const generation = new AbortController();
  const controller = new TuiController({ input, output, mode: "classic", environment: { TERM: "dumb" }, handleSignals: false });
  controller.start();
  controller.setCommandCompletionProvider(async () => [
    { value: "dev", label: "Development" },
    { value: "prod", label: "Production" },
  ], generation.signal);
  input.write("/deploy d\t");
  await tick();
  assert.match(output.text, /Development/u);
  input.write("\u001b[B\r");
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "/deploy prod");
  generation.abort();
  controller.close();
});

test("composable autocomplete applies bounded grapheme ranges and ignores stale generations", async () => {
  const { input, output, controller } = fullController();
  const generation = new AbortController();
  controller.start();
  controller.setAutocompleteProvider(async (text, cursor) => [{ start: 0, end: cursor, value: text.toUpperCase(), label: "Upper" }], generation.signal);
  input.write("go\t");
  await tick();
  assert.equal(controller.getEditorText(), "GO");

  let finish!: (value: readonly { start: number; end: number; value: string }[]) => void;
  const stale = new AbortController();
  controller.setAutocompleteProvider(async () => await new Promise((resolve) => { finish = resolve; }), stale.signal);
  input.write("x\t");
  await tick();
  stale.abort(new Error("extension reloaded"));
  finish([{ start: 0, end: 3, value: "stale" }]);
  await tick();
  assert.equal(controller.getEditorText(), "GOx");

  const malformed = new AbortController();
  controller.setAutocompleteProvider(async () => [{ start: -1, end: 0, value: "bad" }], malformed.signal);
  input.write("\t");
  await tick();
  assert.equal(controller.getEditorText(), "GOx");
  assert.match(output.text, /Autocomplete failed/u);
  controller.close();
});

test("editor middleware is structural, bounded, and cannot retain input after generation abort", async () => {
  const { input, output, controller } = fullController();
  const generation = new AbortController();
  controller.start();
  controller.setEditorMiddleware((event, snapshot) => event.key === "text"
    ? { action: "replace", text: `${snapshot.text}[${event.text}]` }
    : { action: "pass" }, generation.signal);
  input.write("x");
  await tick();
  assert.equal(controller.getEditorText(), "[x]");
  generation.abort(new Error("extension reloaded"));
  input.write("y");
  await tick();
  assert.equal(controller.getEditorText(), "[x]y");

  const malformed = new AbortController();
  controller.setEditorMiddleware(() => ({ action: "replace", text: "bad", cursor: -1 }), malformed.signal);
  input.write("z");
  await tick();
  assert.equal(controller.getEditorText(), "[x]yz");
  assert.match(output.text, /Editor middleware failed/u);
  controller.close();
});

test("extension shortcuts stop at their generation boundary", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  const generation = new AbortController();
  controller.start();
  controller.setExtensionShortcuts([{ shortcut: "alt+z", description: "fixture" }], generation.signal);
  input.write("\u001bz");
  await tick();
  assert.equal(actions[0]?.type, "extension_shortcut");
  if (actions[0]?.type === "extension_shortcut") assert.equal(actions[0].generation, generation.signal);
  generation.abort(new Error("runtime reloaded"));
  input.write("\u001bz");
  await tick();
  assert.equal(actions.length, 1);
  controller.close();
});

test("extension input and editor dialogs work in full and accessibility modes", async () => {
  const full = fullController();
  full.controller.start();
  full.controller.setEditorText("preserved draft");
  const edited = full.controller.editor("Edit value", "prefill");
  full.input.write("!\r");
  assert.equal(await edited, "prefill!");
  assert.equal(full.controller.getEditorText(), "preserved draft");
  full.controller.close();

  const input = new FakeInput();
  const output = new FakeOutput();
  const classic = new TuiController({ input, output, mode: "classic", environment: { TERM: "dumb" }, handleSignals: false });
  classic.start();
  const value = classic.requestInput("Fixture input", "optional");
  assert.match(output.text, /Fixture input \(optional\)/u);
  input.write("\r");
  assert.equal(await value, "");
  classic.close();
});

test("session management commands have exact command-palette entries", async () => {
  for (const expected of ["/session", "/branches"]) {
    const { input, controller } = fullController();
    controller.start();
    const answer = controller.question("you> ");
    input.write(`/${expected.slice(1)}\r`);
    assert.equal(await answer, expected);
    controller.close();
  }

  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("/name release candidate\r");
  assert.equal(await answer, "/name release candidate");
  controller.close();
});

test("suspend, new, tree, and fork application actions are independently remappable", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.setKeybindings(new Keybindings({
    "app.suspend": "alt+z",
    "app.session.new": "alt+n",
    "app.session.tree": "alt+t",
    "app.session.fork": "alt+f",
  }));
  controller.start();
  input.write("\u001bz\u001bn\u001bt\u001bf");
  await tick();
  assert.deepEqual(actions, [
    { type: "suspend" },
    { type: "submit", text: "/new" },
    { type: "submit", text: "/tree" },
    { type: "submit", text: "/fork" },
  ]);
  controller.close();
});

test("Ctrl+P cycles models and Ctrl+O expands tool results", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.start();
  controller.setContext({ provider: "openai", model: "alpha" });
  controller.setPickerItems("model", [
    { id: "openai/alpha", label: "openai / alpha", value: { provider: "openai", model: "alpha" } },
    { id: "anthropic/beta", label: "anthropic / beta", value: { provider: "anthropic", model: "beta" } },
  ]);
  input.write(Buffer.from([16]));
  assert.equal(actions[0]?.type, "select");
  if (actions[0]?.type === "select") assert.deepEqual(actions[0].item.value, { provider: "anthropic", model: "beta" });

  controller.render(envelope({ type: "tool_requested", callId: "call-1", name: "read", input: { path: "README.md" }, index: 0 }));
  controller.render(envelope({
    type: "tool_completed",
    callId: "call-1",
    name: "read",
    index: 0,
    isError: false,
    preview: "one\ntwo\nthree\nfour\nfive\nsix",
  }, 2));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "tool-message-1",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "call-1",
        name: "read",
        content: "one\ntwo\nthree\nfour\nfive\nsix",
        isError: false,
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 3));
  await tick();
  output.chunks.length = 0;
  input.write(Buffer.from([15]));
  await tick();
  assert.match(output.text, /six/u);
  assert.doesNotMatch(output.text, /more lines/u);
  controller.close();
});

test("Ctrl+X requests a copy of the latest assistant message", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  input.write(Buffer.from([24]));
  await tick();
  assert.deepEqual(actions, [{ type: "copy" }]);
  controller.close();
});

test("PageUp can inspect transcript rows already committed to native scrollback", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  for (let index = 0; index < 30; index += 1) {
    controller.render(envelope({ type: "warning", code: `note-${index}`, message: `history-${index}` }, index + 1));
  }
  await tick();
  output.chunks.length = 0;
  input.write("\u001b[5~");
  await tick();
  assert.match(output.text, /history-[0-9]+/u);
  output.chunks.length = 0;
  input.write("\u001b[6~");
  await tick();
  assert.doesNotMatch(output.text, /history-[0-9]+/u);
  controller.close();
});

test("Ctrl+L opens the combined model picker without consuming the draft", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setPickerItems("model", [
    {
      id: "anthropic/claude-sonnet",
      label: "anthropic / claude-sonnet",
      value: { provider: "anthropic", model: "claude-sonnet" },
    },
  ]);
  input.write("keep this draft");
  input.write(Buffer.from([12]));
  input.write("sonnet\r");
  assert.equal(actions[0]?.type, "select");
  if (actions[0]?.type === "select") {
    assert.equal(actions[0].picker, "model");
    assert.deepEqual(actions[0].item.value, { provider: "anthropic", model: "claude-sonnet" });
  }
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "keep this draft");
  controller.close();
});

test("the global model picker can open with a fuzzy query already populated", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.setPickerItems("model", [
    { id: "openai/gpt", label: "openai / gpt", value: { provider: "openai", model: "gpt" } },
    { id: "openai-codex/gpt", label: "openai-codex / gpt", value: { provider: "openai-codex", model: "gpt" } },
  ]);
  controller.openPicker("model", "Models", "codex");
  await tick();
  assert.match(output.text, /> codex/u);
  assert.match(output.text, /gpt \[openai-codex\]/u);
  assert.doesNotMatch(output.text, /gpt \[openai\]/u);
  controller.close();
});

test("session picker exposes sort, named, path, and threaded controls", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setPickerItems("session", [
    {
      id: "parent",
      label: "Parent session",
      detail: "2 messages",
      session: {
        name: "Parent session",
        path: "/tmp/sessions.db#parent",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        current: true,
      },
      value: "parent",
    },
    {
      id: "child",
      label: "Unnamed child",
      detail: "1 message",
      session: {
        path: "/tmp/sessions.db#child",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        parentId: "parent",
      },
      value: "child",
    },
  ]);

  input.write("\u001bs");
  await tick();
  assert.match(output.text, /Resume Session · Current workspace · Name: All · Sort: Threaded · Path: off/u);
  assert.match(output.text, /└─ Unnamed child/u);

  output.chunks.length = 0;
  input.write(Buffer.from([19]));
  input.write(Buffer.from([14]));
  input.write(Buffer.from([16]));
  await tick();
  assert.match(output.text, /Resume Session · Current workspace · Name: Named · Sort: Recent · Path: on/u);
  assert.match(output.text, /\/tmp\/sessions\.db#parent/u);
  assert.doesNotMatch(output.text, /Unnamed child/u);
  controller.close();
});

test("session picker switches live between current and all-workspace catalogs", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.setPickerItems("session", [{
    id: "current",
    label: "Current",
    value: "current",
    session: { path: "local", updatedAt: "2026-01-01", createdAt: "2026-01-01", current: true },
  }]);
  controller.start();
  controller.openPicker("session", "Resume Session");
  input.write(Buffer.from([1]));
  await tick();
  assert.deepEqual(actions, [{ type: "session_scope", scope: "all" }]);
  assert.match(output.text, /All workspaces/u);
  assert.match(output.text, /Loading all workspaces/u);
  controller.setPickerItems("session", [{
    id: "other",
    label: "Other workspace",
    value: "indexed:other",
    session: { path: "indexed:other", workspace: "/other", updatedAt: "2026-01-02", createdAt: "2026-01-02" },
  }]);
  controller.setSessionPickerScope("all");
  await tick();
  assert.match(output.text, /Other workspace/u);
  input.write(Buffer.from([1]));
  await tick();
  assert.deepEqual(actions.at(-1), { type: "session_scope", scope: "current" });
  controller.close();
});

test("session picker requests full-catalog searches and explicit bounded next pages", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.setPickerItems("session", [{
    id: "recent",
    label: "Recent",
    value: "recent",
    session: { path: "local", updatedAt: "2026-01-01", createdAt: "2026-01-01", current: true },
  }]);
  controller.setSessionPickerPagination(true, "1 session loaded · Right loads the next page");
  controller.start();
  controller.openPicker("session", "Resume Session");
  await tick();
  assert.match(output.text, /Right loads the next bounded catalog page/u);

  input.write("archive");
  await tick();
  assert.deepEqual(actions.at(-1), { type: "session_search", scope: "current", query: "archive" });

  controller.setPickerItems("session", [{
    id: "archive",
    label: "Archive",
    value: "archive",
    session: { path: "local", updatedAt: "2025-01-01", createdAt: "2025-01-01" },
  }]);
  controller.setSessionPickerPagination(true, "1 matching session loaded · Right loads the next page");
  input.write("\u001b[C");
  await tick();
  assert.deepEqual(actions.at(-1), { type: "session_more", scope: "current", query: "archive" });
  controller.close();
});

test("session picker renames, confirms deletion, and protects the active session", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.start();
  controller.setPickerItems("session", [
    {
      id: "active",
      label: "Active",
      session: {
        name: "Active",
        path: "/tmp/sessions.db#active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        current: true,
      },
      value: "active",
    },
    {
      id: "older",
      label: "Older",
      session: {
        name: "Older",
        path: "/tmp/sessions.db#older",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      value: "older",
    },
  ]);

  input.write("\u001bs");
  input.write(Buffer.from([18]));
  input.write(Buffer.from([21]));
  input.write("Renamed active\r");
  await tick();
  assert.equal(actions[0]?.type, "session_rename");
  if (actions[0]?.type === "session_rename") {
    assert.equal(actions[0].item.value, "active");
    assert.equal(actions[0].name, "Renamed active");
  }

  input.write(Buffer.from([4]));
  await tick();
  assert.match(output.text, /active session cannot be deleted/u);
  assert.equal(actions.length, 1);

  input.write("\u001b[B");
  input.write(Buffer.from([4]));
  await tick();
  assert.match(output.text, /Delete session permanently/u);
  assert.match(output.text, /Delete “Older”\?/u);
  input.write("\r");
  await tick();
  assert.equal(actions[1]?.type, "session_delete");
  if (actions[1]?.type === "session_delete") assert.equal(actions[1].item.value, "older");
  assert.match(output.text, /Resume Session · Current workspace · Name: All · Sort: Threaded/u);
  controller.close();
});

test("a reloaded keymap replaces an application shortcut immediately", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setPickerItems("model", [{ id: "model", label: "custom model", value: "model" }]);
  controller.setKeybindings(new Keybindings({ "app.model.select": "ctrl+k" }));
  input.write(Buffer.from([11]));
  await tick();
  assert.match(output.text, /custom model/u);
  controller.close();
});

test("at completion inserts a selected workspace file and Tab completes a unique path", async () => {
  const { input, controller } = fullController();
  controller.start();
  controller.setPickerItems("file", [
    { id: "src/main.ts", label: "src/main.ts", value: "src/main.ts" },
    { id: "README.md", label: "README.md", value: "README.md" },
  ]);
  input.write("@");
  input.write("main\r");
  input.write(" and \u001b[200~@READ\u001b[201~");
  input.write("\t");
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "@src/main.ts and @README.md");
  controller.close();
});

test("Ctrl+G round-trips the current draft through an external editor operation", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  input.write("before");
  let outputWhileEditing = "";
  await controller.editExternally(async (text) => {
    outputWhileEditing = output.text;
    return `${text} after`;
  });
  assert.match(outputWhileEditing, /\u001b\[\?2004l/u);
  assert.doesNotMatch(outputWhileEditing, /\u001b\[\?1049l/u);
  assert.match(output.text.slice(outputWhileEditing.length), /\u001b\[\?2004h/u);
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "before after");
  assert.deepEqual(input.rawChanges.slice(-2), [false, true]);
  controller.close();
});

test("closing the TUI cancels an active external editor operation", async () => {
  const { controller } = fullController();
  controller.start();
  let observedSignal: AbortSignal | undefined;
  const editing = controller.editExternally(async (_text, signal) => {
    observedSignal = signal;
    return await new Promise<string>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  });
  assert.equal(observedSignal?.aborted, false);
  controller.close();
  await assert.rejects(editing, /Terminal closed/u);
  assert.equal(observedSignal?.aborted, true);
});

test("Alt+Enter queues a follow-up while active and Shift+Ctrl+P cycles models backward", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.setContext({ provider: "anthropic", model: "beta" });
  controller.setPickerItems("model", [
    { id: "openai/alpha", label: "alpha", value: { provider: "openai", model: "alpha" } },
    { id: "anthropic/beta", label: "beta", value: { provider: "anthropic", model: "beta" } },
  ]);
  input.write("\u001b[112;6u");
  controller.setSteering((line) => actions.push({ type: "steer", text: line }));
  input.write("later\u001b\r");
  await tick();
  assert.equal(actions[0]?.type, "select");
  if (actions[0]?.type === "select") assert.deepEqual(actions[0].item.value, { provider: "openai", model: "alpha" });
  assert.deepEqual(actions[1], { type: "steer", text: "/follow later" });
  controller.close();
});

test("controller maps Alt+Enter follow-up and Escape cancellation through the steering channel", async () => {
  const { input, controller } = fullController();
  const lines: string[] = [];
  controller.start();
  controller.setSteering((line) => lines.push(line));
  input.write("after this\u001b\r");
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  await tick();
  assert.deepEqual(lines, ["/follow after this", "/cancel"]);
  controller.close();
});

test("Alt+Up requests dequeue and restored messages preserve the current draft", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.start();
  controller.setQueuedMessages([
    { mode: "steer", text: "change direction" },
    { mode: "follow_up", text: "then verify" },
  ]);
  input.write("current draft");
  input.write("\u001b[1;3A");
  await tick();
  assert.deepEqual(actions, [{ type: "dequeue" }]);
  assert.match(output.text, /Steering: change direction/u);
  assert.match(output.text, /Follow-up: then verify/u);
  assert.equal(controller.restoreQueuedMessages([
    { mode: "steer", text: "change direction" },
    { mode: "follow_up", text: "then verify" },
  ]), 2);
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "change direction\n\nthen verify\n\ncurrent draft");
  controller.close();
});

test("queued embedded and URL images restore invisibly as exact pending payloads and remain visible until submit", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const images = [
    { type: "image" as const, mediaType: "image/png", data: "iVBORw==" },
    { type: "image" as const, mediaType: "image/jpeg", url: "https://images.example.test/two.jpg" },
  ];
  const queued = {
    mode: "follow_up",
    text: "compare these",
    images,
  } as const;
  controller.setQueuedMessages([queued]);
  await tick();
  assert.match(output.text, /Follow-up: compare these · \[2 images\]/u);
  assert.match(output.text, /restore the next queued message with its attachments/u);
  assert.equal(controller.restoreQueuedMessages([queued]), 1);
  controller.setDraftScope("other-session");
  assert.equal(controller.getEditorText(), "");
  controller.setDraftScope("default");
  controller.setEditorText("compare these after editing");
  await tick();
  assert.match(output.text, /recovered 1 \(embedded\).*image\/png/u);
  assert.match(output.text, /recovered 2 \(URL\)/u);
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "compare these after editing");
  assert.deepEqual(controller.takeSubmittedRecoveredImages(), images);
  controller.close();
});

test("restored image payloads cross the active steering callback exactly once", async () => {
  const { input, controller } = fullController();
  const images = [
    { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" },
    { type: "image" as const, mediaType: "image/jpeg", url: "https://images.example.test/active.jpg" },
  ];
  let observed: { text: string; recovered: readonly ImageBlock[] } | undefined;
  controller.start();
  controller.setSteering((text, _attachments, recovered) => {
    observed = { text, recovered: recovered ?? [] };
  });
  controller.restoreQueuedMessages([{ mode: "steer", text: "active recovered", images }]);
  controller.setEditorText("active recovered edited");
  input.write("\r");
  await tick();
  assert.deepEqual(observed, { text: "active recovered edited", recovered: images });
  assert.deepEqual(controller.takeSubmittedRecoveredImages(), []);
  controller.close();
});

test("clearing a restored queue draft requests durable lease release", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  controller.restoreQueuedMessages([{ mode: "follow_up", text: "restore then clear" }]);
  input.write(Buffer.from([3]));
  await tick();
  assert.deepEqual(actions, [{ type: "queue_restore_discard" }]);
  assert.equal(controller.getEditorText(), "");
  controller.close();
});

test("Ctrl+C clears once and exits on a second press while Ctrl+D exits only when empty", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  input.write("draft");
  input.write(Buffer.from([3]));
  assert.equal(controller.getEditorText(), "");
  input.write(Buffer.from([3]));
  await tick();
  assert.deepEqual(actions, [{ type: "exit" }]);
  actions.length = 0;
  input.write(Buffer.from([4]));
  await tick();
  assert.deepEqual(actions, [{ type: "exit" }]);
  controller.close();
});

test("double Escape on an empty editor follows the configured tree, fork, or none action", async () => {
  for (const [configured, expected] of [["tree", "/tree"], ["fork", "/fork"], ["none", undefined]] as const) {
    const actions: TuiAction[] = [];
    const { input, controller } = fullController({ actions, doubleEscapeAction: configured });
    controller.start();
    input.write("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    input.write("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    const submission = actions.find((action) => action.type === "submit");
    assert.equal(submission?.type === "submit" ? submission.text : undefined, expected);
    controller.close();
  }
});

test("input EOF exits and settles a pending question", async () => {
  const actions: TuiAction[] = [];
  const { input, controller } = fullController({ actions });
  controller.start();
  const answer = controller.question("you> ");

  input.end();

  await assert.rejects(answer, /Terminal closed/u);
  await tick();
  assert.deepEqual(actions, [{ type: "exit" }]);
});

test("Shift+Enter inserts a newline and Alt+D deletes the next word", async () => {
  const { input, controller } = fullController();
  controller.start();
  const answer = controller.question("you> ");
  input.write("one two");
  input.write("\u001b[H\u001b[C\u001b[C\u001b[C\u001b[C");
  input.write("\u001bd");
  input.write("\u001b[13;2u");
  input.write("three\r");
  assert.equal(await answer, "one \nthree");
  controller.close();
});

test("classic fallback supports questions without alternate-screen control codes", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.isTTY = false;
  output.isTTY = false;
  const controller = new TuiController({ input, output, environment: { TERM: "dumb" }, handleSignals: false });
  const answer = controller.question("prompt> ");
  input.write("plain input\n");
  assert.equal(await answer, "plain input");
  assert.doesNotMatch(output.text, /1049/u);
  assert.match(output.text, /prompt>/u);
  controller.close();
});

test("classic fallback uses a line-oriented picker", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.isTTY = false;
  output.isTTY = false;
  const controller = new TuiController({ input, output, environment: { TERM: "dumb" }, handleSignals: false });
  const selection = controller.choose("Select model", [
    { label: "Alpha", detail: "fast", value: "alpha" },
    { label: "Beta", detail: "deep", value: "beta" },
  ]);
  await tick();
  assert.match(output.text, /1\. Alpha — fast/u);
  assert.match(output.text, /type to search, Enter for 1, or \/cancel/u);
  input.write("2\n");
  assert.equal(await selection, "beta");
  controller.close();
});

test("steering alone does not label shell work as model generation", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  controller.setContext({ active: false, status: "idle" });
  controller.setSteering(() => {});
  await tick();
  assert.doesNotMatch(output.text, /Generating response/u);
  controller.close();
});

test("classic fallback submits slash commands without opening an interactive picker", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  input.isTTY = false;
  output.isTTY = false;
  const controller = new TuiController({ input, output, environment: { TERM: "dumb" }, handleSignals: false });
  const answer = controller.question("prompt> ");
  input.write("/exit\n");
  assert.equal(await answer, "/exit");
  assert.doesNotMatch(output.text, /Commands|search>/u);
  controller.close();
});

test("accessibility mode never emits cursor-control sequences", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "accessible",
    environment: { TERM: "xterm", RIGYN_ASCII: "1", NO_COLOR: "1" },
    handleSignals: false,
  });
  controller.start();
  controller.render(envelope({ type: "warning", code: "note", message: "visible warning" }));
  const answer = controller.question("answer> ");
  input.write("yes\n");
  assert.equal(await answer, "yes");
  assert.match(output.text, /\[warning\] visible warning/u);
  assert.doesNotMatch(output.text, /\u001b/u);
  controller.close();
});

test("resize causes a fresh bounded frame", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  output.resize(42, 12);
  await tick();
  assert.ok(output.chunks.length > 0);
  assert.match(output.text, /\u001b\[\?2026h/u);
  assert.match(output.text, /\u001b\[2K/u);
  assert.doesNotMatch(output.text, /\u001b\[(?:2J|3J|H)/u);
  controller.close();
});

test("ordinary editor input updates one live row instead of clearing the surface", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  input.write("x");
  await tick();
  assert.match(output.text, /\u001b\[\?2026h/u);
  assert.equal(output.text.match(/\u001b\[2K/gu)?.length, 1);
  assert.doesNotMatch(output.text, /\u001b\[(?:J|2J|3J|H)/u);
  controller.close();
});

test("signals and stream errors restore terminal state and report actions", () => {
  const signals = new FakeSignals();
  const actions: TuiAction[] = [];
  const first = fullController({ signals, actions });
  first.controller.start();
  signals.signal("SIGTERM");
  assert.equal(first.input.isRaw, false);
  assert.deepEqual(actions, [{ type: "signal", signal: "SIGTERM" }]);
  assert.match(first.output.text, /\u001b\[\?2004l/u);
  assert.doesNotMatch(first.output.text, /\u001b\[\?1049l/u);

  const failures: TuiAction[] = [];
  const second = fullController({ actions: failures });
  second.controller.start();
  second.input.emit("error", new Error("boom"));
  assert.equal(second.input.isRaw, false);
  assert.equal(failures[0]?.type, "error");
  if (failures[0]?.type === "error") assert.equal(failures[0].error.message, "boom");
  assert.match(second.output.text, /\u001b\[\?2004l/u);
  assert.doesNotMatch(second.output.text, /\u001b\[\?1049l/u);
});

test("clearing model context removes a disconnected provider from the footer", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.setContext({ provider: "openai", model: "gpt-test" });
  await tick();
  output.chunks.length = 0;
  controller.clearModelContext();
  await tick();
  assert.doesNotMatch(output.text, /openai|gpt-test/u);
  controller.close();
});

test("closing rejects a pending question after restoring terminal state", async () => {
  const { input, controller } = fullController();
  controller.start();
  const question = controller.question("waiting> ");
  controller.close();
  await assert.rejects(question, /Terminal closed/u);
  assert.equal(input.isRaw, false);
});

test("rendered provider events are escaped before reaching the terminal", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.render(envelope({ type: "warning", code: "unsafe", message: "safe\u001b[2Jowned" }));
  await tick();
  assert.match(output.text, /safeowned/u);
  assert.doesNotMatch(output.text, /safe\u001b\[2Jowned/u);
  controller.close();
});

test("controller registers and visibly applies declarative package themes", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    handleSignals: false,
  });
  controller.start();
  controller.setCustomThemes([parseThemeDefinition({
    schemaVersion: 1,
    name: "ocean",
    styles: { accent: { foreground: "#00aaff" } },
  })]);
  assert.deepEqual(controller.themeNames(), ["dark", "light", "mono", "ocean"]);
  output.chunks.length = 0;
  controller.setTheme("ocean");
  await tick();
  assert.match(output.text, /38;2;0;170;255m/u);
  assert.equal(controller.selectedThemeName(), "ocean");
  controller.setCustomThemes([]);
  assert.equal(controller.selectedThemeName(), "dark");
  assert.deepEqual(controller.themeNames(), ["dark", "light", "mono"]);
  controller.close();
});

test("theme selection and catalog invalidation emit generation-owned changes", () => {
  const { controller } = fullController();
  const generation = new AbortController();
  const changes: Array<[string, string, string]> = [];
  controller.start();
  controller.onThemeChange((change) => changes.push([change.previous, change.current, change.reason]), generation.signal);
  controller.setCustomThemes([parseThemeDefinition({
    schemaVersion: 1,
    name: "reactive",
    styles: { accent: { foreground: "#001122" } },
  })]);
  controller.setTheme("reactive");
  controller.setCustomThemes([parseThemeDefinition({
    schemaVersion: 1,
    name: "reactive",
    styles: { accent: { foreground: "#334455" } },
  })]);
  assert.deepEqual(changes, [
    ["dark", "reactive", "selection"],
    ["reactive", "reactive", "catalog"],
  ]);
  generation.abort();
  controller.setTheme("dark");
  assert.equal(changes.length, 2);
  controller.close();
});

test("extension status, widget, and title render through bounded TUI primitives", async () => {
  const { output, controller } = fullController();
  controller.start();
  output.chunks.length = 0;
  controller.setExtensionStatus("probe:ready", "probe ready");
  controller.setExtensionWidget("probe:panel", "first line\nsecond line");
  controller.setTitle("probe\u001b]2;owned");
  await tick();
  assert.match(output.text, /probe ready/u);
  assert.match(output.text, /first line/u);
  assert.match(output.text, /second line/u);
  assert.match(output.text, /\u001b\]0;probe2;owned\u0007/u);
  assert.doesNotMatch(output.text, /\u001b\]2;owned/u);
  controller.close();
});

test("extension working controls replace and hide the bounded host activity row", async () => {
  const shown = fullController();
  shown.controller.start();
  shown.controller.setExtensionWorkingMessage("probe", "Indexing workspace\u001b[2J");
  shown.controller.setContext({ active: true, status: "streaming" });
  await tick();
  assert.match(shown.output.text, /Indexing workspace/u);
  assert.doesNotMatch(shown.output.text, /\u001b\[2J/u);
  shown.controller.close();

  const hidden = fullController();
  hidden.controller.start();
  hidden.controller.setExtensionWorkingVisible("probe", false);
  hidden.controller.setContext({ active: true, status: "streaming" });
  await tick();
  assert.doesNotMatch(hidden.output.text, /Preparing request/u);
  hidden.controller.close();
});

test("transient host status replaces one live row and clears without entering the transcript", async () => {
  const full = fullController();
  full.controller.start();
  full.output.chunks.length = 0;
  full.controller.setTransientStatus("shell stdout one");
  await tick();
  assert.match(full.output.text, /shell stdout one/u);
  full.output.chunks.length = 0;
  full.controller.setTransientStatus("shell stderr two");
  await tick();
  assert.match(full.output.text, /shell stderr two/u);
  full.controller.setTransientStatus();
  await tick();
  full.output.chunks.length = 0;
  full.controller.notify("after shell");
  await tick();
  assert.doesNotMatch(full.output.text, /shell stdout one|shell stderr two/u);
  full.controller.close();

  const input = new FakeInput();
  const output = new FakeOutput();
  const accessible = new TuiController({ input, output, mode: "accessible", environment: { TERM: "dumb" }, handleSignals: false });
  accessible.start();
  output.chunks.length = 0;
  accessible.setTransientStatus("first");
  accessible.setTransientStatus("second");
  accessible.setTransientStatus();
  assert.match(output.text, /\r\[status\] first/u);
  assert.match(output.text, /\r\[status\] second/u);
  assert.match(output.text, /\r\s+\r/u);
  accessible.close();
});

test("runtime command components render safely, receive keys, and end with their generation", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  let disposed = 0;
  const result = controller.custom<string>((host) => ({
    render: () => ({
      lines: [{ spans: [{ text: "extension panel", role: "accent" }], fill: true }],
      cursor: { row: 0, column: 9 },
    }),
    handleKey: (event) => {
      if (event.key !== "text" || event.text === undefined) return false;
      host.close(event.text);
      return true;
    },
    dispose: () => { disposed += 1; },
  }));
  await tick();
  assert.match(output.text, /extension panel/u);
  input.write("z");
  assert.equal(await result, "z");
  assert.equal(disposed, 1);

  const generation = new AbortController();
  const expired = controller.custom(() => ({
    render: () => ({ lines: [{ spans: [{ text: "temporary" }] }] }),
    dispose: () => { disposed += 1; },
  }), undefined, generation.signal);
  generation.abort(new Error("extension reload"));
  assert.equal(await expired, undefined);
  assert.equal(disposed, 2);
  controller.close();
});

test("runtime command components receive the physical dimensions of a tiny terminal", async () => {
  const { input, output, controller } = fullController();
  output.resize(12, 4);
  const dimensions: Array<[number, number]> = [];
  const result = controller.custom<string>((host) => ({
    render: (context) => {
      dimensions.push([context.width, context.height]);
      return { lines: [{ spans: [{ text: "panel" }] }] };
    },
    handleKey: (event) => {
      if (event.text === undefined) return false;
      host.close(event.text);
      return true;
    },
  }));
  await tick();
  assert.deepEqual(dimensions.at(-1), [12, 4]);
  input.write("x");
  assert.equal(await result, "x");
  controller.close();
});

test("runtime overlay handles toggle visibility and focus without stealing non-capturing input", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setEditorText("draft");
  let handle: import("../../src/tui/components.js").RuntimeUiComponentHandle | undefined;
  const result = controller.custom<string>((host) => ({
    render: () => ({ lines: [{ spans: [{ text: "floating panel", role: "accent" }], fill: true }] }),
    handleKey: (event) => {
      if (event.key !== "text" || event.text === undefined) return false;
      host.close(event.text);
      return true;
    },
  }), {
    overlay: true,
    overlayOptions: { anchor: "top-right", width: 20, margin: 1, nonCapturing: true },
    onHandle: (value) => { handle = value; },
  });
  await tick();
  assert.match(output.text, /floating panel/u);
  assert.equal(handle?.isFocused(), false);
  input.write("a");
  await tick();
  handle?.setHidden(true);
  const hiddenOffset = output.text.length;
  await tick();
  assert.doesNotMatch(output.text.slice(hiddenOffset), /floating panel/u);
  handle?.setHidden(false);
  handle?.focus();
  assert.equal(handle?.isFocused(), true);
  input.write("z");
  assert.equal(await result, "z");
  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "drafta");
  controller.close();
});

test("extension overlays stack independently and route keys to the focused layer", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  controller.setEditorText("draft");
  const keys: string[] = [];
  let disposed = 0;
  const first = controller.showOverlay<string>((host) => ({
    render: () => ({ lines: [{ spans: [{ text: "first overlay", role: "accent" }], fill: true }] }),
    handleKey: (event) => {
      keys.push(`first:${event.text ?? event.key}`);
      if (event.text === "1") host.close("first-result");
      return true;
    },
    dispose: () => { disposed += 1; },
  }), { overlayOptions: { anchor: "top-left", width: 16 } });
  const second = controller.showOverlay<string>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "second overlay", role: "success" }], fill: true }] }),
    handleKey: (event) => {
      keys.push(`second:${event.text ?? event.key}`);
      return true;
    },
    dispose: () => { disposed += 1; },
  }), { overlayOptions: { anchor: "top-right", width: 16 } });

  await tick();
  assert.match(output.text, /first overlay/u);
  assert.match(output.text, /second overlay/u);
  assert.equal(first.isFocused(), false);
  assert.equal(second.isFocused(), true);
  input.write("x");
  await tick();
  assert.deepEqual(keys, ["second:x"]);

  first.focus();
  assert.equal(first.isFocused(), true);
  assert.equal(second.isFocused(), false);
  input.write("1");
  assert.equal(await first.result, "first-result");
  assert.deepEqual(keys, ["second:x", "first:1"]);
  second.setHidden(true);
  assert.equal(second.isHidden(), true);
  second.close();
  assert.equal(await second.result, undefined);
  assert.equal(disposed, 2);
  controller.close();
});

test("overlay focus order, hiding, visibility, and unfocus restore input deterministically", async () => {
  const { input, controller } = fullController();
  controller.start();
  controller.setEditorText("draft");
  const keys: string[] = [];
  const lower = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "lower" }], fill: true }] }),
    handleKey: (event) => { keys.push(`lower:${event.text ?? event.key}`); return true; },
  }), { overlayOptions: { row: 0, col: 0, width: 8 } });
  let upperVisible = true;
  const upper = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "upper" }], fill: true }] }),
    handleKey: (event) => { keys.push(`upper:${event.text ?? event.key}`); return true; },
  }), { overlayOptions: { row: 0, col: 0, width: 8, visible: () => upperVisible } });

  input.write("a");
  await tick();
  upperVisible = false;
  input.write("b");
  await tick();
  upperVisible = true;
  input.write("c");
  await tick();
  assert.deepEqual(keys, ["upper:a", "lower:b", "upper:c"]);

  upper.setHidden(true);
  assert.equal(upper.isFocused(), false);
  input.write("d");
  await tick();
  upper.setHidden(false);
  assert.equal(upper.isFocused(), true);
  input.write("e");
  await tick();
  upper.unfocus();
  input.write("f");
  await tick();
  lower.unfocus({ target: null });
  input.write("g");
  await tick();
  assert.deepEqual(keys, ["upper:a", "lower:b", "upper:c", "lower:d", "upper:e", "lower:f"]);

  const answer = controller.question("you> ");
  input.write("\r");
  assert.equal(await answer, "draftg");
  upper.hide();
  lower.hide();
  assert.equal(await upper.result, undefined);
  assert.equal(await lower.result, undefined);
  upper.focus();
  assert.equal(upper.isFocused(), false);
  controller.close();
});

test("overlay focus raises visual order and dynamic sizing is resolved once with minWidth", async () => {
  const { output, controller } = fullController();
  controller.start();
  let optionCalls = 0;
  const widths: number[] = [];
  const lower = controller.showOverlay<void>(() => ({
    render: (context) => {
      widths.push(context.width);
      return { lines: [{ spans: [{ text: "LOWER_ONLY" }], fill: true }] };
    },
  }), {
    overlayOptions: () => {
      optionCalls += 1;
      return { row: 0, col: 0, width: 5, minWidth: 12, nonCapturing: true };
    },
  });
  const upper = controller.showOverlay<void>(() => ({
    render: () => ({ lines: [{ spans: [{ text: "UPPER_ONLY" }], fill: true }] }),
  }), { overlayOptions: { row: 0, col: 0, width: 12, nonCapturing: true } });
  await tick();
  assert.match(output.text, /UPPER_ONLY/u);
  assert.equal(optionCalls, 1);
  assert.deepEqual(widths, [12]);

  output.chunks.length = 0;
  lower.focus();
  await tick();
  assert.match(output.text, /LOWER_ONLY/u);
  assert.doesNotMatch(output.text, /UPPER_ONLY/u);
  assert.equal(optionCalls, 1);
  lower.close();
  upper.close();
  await Promise.all([lower.result, upper.result]);
  controller.close();
});

test("runtime overlay options reject unsafe dimensions before mounting", async () => {
  const { controller } = fullController();
  controller.start();
  await assert.rejects(controller.custom(() => ({ render: () => ({ lines: [] }) }), {
    overlay: true,
    overlayOptions: { width: "0%" },
  }), /width must be more than 0% to 100%/u);
  assert.throws(() => controller.showOverlay(() => ({ render: () => ({ lines: [] }) }), {
    overlayOptions: { minWidth: 0 },
  }), /minWidth must be a positive safe integer/u);
  controller.close();
});

test("full TUI owns generation-bound tool renderers and falls back after expiry or failure", async () => {
  const { output, controller } = fullController({ alternateScreen: true });
  controller.start();
  const v1 = new AbortController();
  let v1Calls = 0;
  controller.setToolRenderers({
    has: (name) => name === "read",
    renderCall: (_name, view) => {
      v1Calls += 1;
      return { lines: [{ spans: [{ text: `V1 CALL ${String((view.input as { path?: string } | undefined)?.path)}`, role: "accent" }] }] };
    },
    renderResult: (_name, view) => ({ lines: [{ spans: [{
      text: `V1 ${view.isPartial === true ? "PARTIAL" : "RESULT"} ${view.result?.content ?? ""}`,
      role: "success",
    }] }] }),
  }, v1.signal);
  controller.render(envelope({ type: "tool_requested", callId: "one", name: "read", input: { path: "one.ts" }, index: 0 }, 1));
  controller.render(envelope({ type: "tool_started", callId: "one", name: "read", index: 0 }, 2));
  controller.render(envelope({
    type: "tool_progress",
    callId: "one",
    name: "read",
    index: 0,
    sequence: 0,
    progress: { type: "result", content: "one running", isError: false, metadata: { phase: "running" } },
  }, 3));
  await tick();
  assert.match(output.text, /V1 CALL one\.ts/u);
  assert.match(output.text, /V1 PARTIAL one running/u);
  output.chunks.length = 0;
  controller.render(envelope({ type: "tool_completed", callId: "one", name: "read", index: 0, isError: false, preview: "one result" }, 4));
  await tick();
  assert.match(output.text, /V1 RESULT one result/u);

  const callsBeforeAbort = v1Calls;
  v1.abort(new Error("reload"));
  output.chunks.length = 0;
  controller.render(envelope({ type: "tool_requested", callId: "two", name: "read", input: { path: "two.ts" }, index: 1 }, 5));
  await tick();
  assert.equal(v1Calls, callsBeforeAbort);
  assert.match(output.text, /Read · \[ts\] two\.ts · queued/u);
  assert.doesNotMatch(output.text, /V1 CALL two\.ts/u);

  const failed = new AbortController();
  controller.setToolRenderers({
    has: () => true,
    renderCall: () => { throw new Error("renderer failed"); },
    renderResult: () => undefined,
  }, failed.signal);
  output.chunks.length = 0;
  controller.render(envelope({ type: "tool_requested", callId: "three", name: "read", input: { path: "three.ts" }, index: 2 }, 6));
  await tick();
  assert.match(output.text, /Read · \[ts\] three\.ts · queued/u);
  controller.close();
});

test("full TUI owns generation-bound extension session renderers with branch-safe fallback", async () => {
  const { output, controller } = fullController({ alternateScreen: true });
  controller.start();
  const generation = new AbortController();
  const branches: string[] = [];
  controller.setSessionRenderers({
    renderState: (value, branch) => {
      branches.push(branch);
      return { lines: [{ spans: [{ text: `CUSTOM STATE ${String((value.event.value as { count?: number }).count)}`, role: "accent" }] }] };
    },
    renderMessage: (value, branch) => {
      branches.push(branch);
      return { lines: [{ spans: [{ text: `CUSTOM MESSAGE ${value.event.kind}`, role: "success" }] }] };
    },
  }, generation.signal);
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() { throw new Error("inherited serializer must not run"); },
    });
    controller.renderExtensionSession(envelope({
      type: "extension_state",
      extensionId: "owner.extension",
      schemaVersion: 1,
      key: "counter",
      value: { count: 3 },
    }, 30) as never, "experiment");
  } finally {
    if (original === undefined) delete (Object.prototype as Record<string, unknown>).toJSON;
    else Object.defineProperty(Object.prototype, "toJSON", original);
  }
  controller.renderExtensionSession(envelope({
    type: "extension_message",
    extensionId: "owner.extension",
    schemaVersion: 1,
    kind: "notice",
    messageId: "notice-message",
    payload: { renderer: true },
    modelContext: false,
    transcript: { text: "safe fallback" },
  }, 31) as never, "experiment");
  await tick();
  assert.match(output.text, /CUSTOM STATE 3/u);
  assert.match(output.text, /CUSTOM MESSAGE notice/u);
  assert.deepEqual(branches, ["experiment", "experiment"]);

  generation.abort(new Error("extension generation reloaded"));
  output.chunks.length = 0;
  controller.clearTranscript();
  controller.renderExtensionSession(envelope({
    type: "extension_message",
    extensionId: "owner.extension",
    schemaVersion: 1,
    kind: "fallback",
    messageId: "fallback-message",
    payload: { secret: "must stay renderer-only" },
    modelContext: false,
    transcript: { text: "SAFE FALLBACK" },
  }, 32) as never, "main");
  await tick();
  assert.match(output.text, /owner\.extension\/fallback: SAFE FALLBACK/u);
  assert.doesNotMatch(output.text, /must stay renderer-only|CUSTOM MESSAGE/u);
  assert.throws(() => controller.renderExtensionSession(envelope({
    type: "extension_state",
    extensionId: "owner.extension",
    schemaVersion: 1,
    key: "invalid_branch",
    value: null,
  }, 33) as never, "../outside"), /requires a branch/u);
  controller.close();
});

test("runtime presentation replacement clears stale UI and blocks input without losing the draft", async () => {
  const actions: TuiAction[] = [];
  const { input, output, controller } = fullController({ actions });
  controller.start();
  const answer = controller.question("you> ");
  input.write("keep draft");
  controller.setExtensionStatus("old:status", "old status");
  controller.setExtensionWidget("old:widget", "old widget");
  controller.setCommandItems([{ id: "old-command", label: "/old-command", value: "/old-command" }]);
  controller.setInputBlocked("Reloading keybindings, extensions, skills, prompts, themes, and context files...", "reload");
  input.write(" ignored");
  input.write("\u001b");
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  assert.match(output.text, /Reloading keybindings/u);
  assert.match(output.text, /reload>/u);
  assert.equal(actions.at(-1)?.type, "cancel");

  controller.clearExtensionUi();
  controller.setCommandItems([{ id: "new-command", label: "/new-command", value: "/new-command" }]);
  controller.setInputBlocked();
  output.chunks.length = 0;
  controller.openPicker("command", "Commands");
  input.write("new-command");
  await tick();
  assert.match(output.text, /new-command/u);
  assert.doesNotMatch(output.text, /old-command|old status|old widget/u);
  input.write(Buffer.from([3]));
  input.write("\r");
  assert.equal(await answer, "keep draft");
  controller.close();
});

test("blocked operations use their semantic input label", async () => {
  const { output, controller } = fullController();
  controller.start();
  controller.setInputBlocked("Reading clipboard…", "clipboard");
  await tick();
  assert.match(output.text, /clipboard>/u);
  assert.doesNotMatch(output.text, /reload>/u);
  controller.close();
});
