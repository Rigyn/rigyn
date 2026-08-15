import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { EventEnvelope, RuntimeEvent } from "../../src/core/events.js";
import { EventRenderer, TerminalController, readSecretFrom } from "../../src/interfaces/terminal.js";

function envelope(event: RuntimeEvent, sequence: number): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    threadId: "thread-terminal",
    sequence,
    timestamp: "2026-08-08T12:00:00.000Z",
    event,
  };
}

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

test("terminal picker supports filtering and numbered selection", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rendered: Buffer[] = [];
  output.on("data", (chunk: Buffer) => rendered.push(chunk));
  const terminal = new TerminalController(input, output);
  const selection = terminal.choose("Select model", [
    { label: "alpha-fast", value: "a" },
    { label: "beta-smart", detail: "large context", value: "b" },
  ]);
  input.write("smart\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write("1\n");
  assert.equal(await selection, "b");
  assert.match(Buffer.concat(rendered).toString("utf8"), /beta-smart/u);
  terminal.close();
});

test("TTY toggle picker starts on its safe choice and supports arrows and direct numbers", async () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(mode: boolean): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  const rawModes: boolean[] = [];
  input.setRawMode = (mode) => { input.isRaw = mode; rawModes.push(mode); };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
  output.isTTY = true;
  output.columns = 72;
  const rendered: Buffer[] = [];
  output.on("data", (chunk: Buffer) => rendered.push(Buffer.from(chunk)));
  const terminal = new TerminalController(input, output);
  const controllerRawMode = input.isRaw;
  const choices = [
    { label: "Enable this workspace", value: "workspace" },
    { label: "Enable for this launch", value: "launch" },
    { label: "Keep disabled for this workspace", value: "disabled" },
    { label: "Keep disabled for this launch", value: "disabled-launch" },
  ];

  const arrowSelection = terminal.chooseToggle("Project resources found", choices, { initialIndex: 3 });
  input.write("\u001b[");
  input.write("D\r");
  assert.equal(await arrowSelection, "disabled");
  assert.equal(input.isRaw, controllerRawMode);

  const directSelection = terminal.chooseToggle("Project resources found", choices, { initialIndex: 3 });
  input.write("1");
  assert.equal(await directSelection, "workspace");
  assert.equal(input.isRaw, controllerRawMode);

  const text = Buffer.concat(rendered).toString("utf8");
  assert.match(text, /Keep disabled for this launch/u);
  assert.match(text, /Left\/Right choose/u);
  assert.doesNotMatch(text, /1\. Enable this workspace.*2\. Enable for this launch/su);
  terminal.close();
  assert.equal(input.isRaw, false);
});

test("toggle picker keeps the numbered accessibility fallback and restores raw mode on cancellation", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new TerminalController(input, output);
  const choices = [
    { label: "Enable", value: true },
    { label: "Keep disabled", value: false },
  ];
  const fallback = terminal.chooseToggle("Project resources found", choices, { initialIndex: 1 });
  input.write("2\n");
  assert.equal(await fallback, false);
  terminal.close();

  const ttyInput = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(mode: boolean): void;
  };
  ttyInput.isTTY = true;
  ttyInput.isRaw = false;
  ttyInput.setRawMode = (mode) => { ttyInput.isRaw = mode; };
  const ttyOutput = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
  ttyOutput.isTTY = true;
  ttyOutput.columns = 80;
  const tty = new TerminalController(ttyInput, ttyOutput);
  const controllerRawMode = ttyInput.isRaw;
  const selection = tty.chooseToggle("Project resources found", choices, { initialIndex: 1 });
  ttyInput.write("\u001b");
  await assert.rejects(selection, /Selection cancelled/u);
  assert.equal(ttyInput.isRaw, controllerRawMode);
  tty.close();
  assert.equal(ttyInput.isRaw, false);
});

test("TTY toggle picker honors the control-sequence-free accessibility request", async () => {
  const previous = process.env.RIGYN_ACCESSIBLE;
  process.env.RIGYN_ACCESSIBLE = "1";
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(mode: boolean): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  const rawModes: boolean[] = [];
  input.setRawMode = (mode) => { input.isRaw = mode; rawModes.push(mode); };
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
  output.isTTY = true;
  output.columns = 80;
  const terminal = new TerminalController(input, output);
  const modesBeforeSelection = rawModes.length;
  try {
    const selection = terminal.chooseToggle("Project resources found", [
      { label: "Enable", value: true },
      { label: "Keep disabled", value: false },
    ], { initialIndex: 1 });
    input.write("2\n");
    assert.equal(await selection, false);
    assert.equal(rawModes.length, modesBeforeSelection);
  } finally {
    terminal.close();
    if (previous === undefined) delete process.env.RIGYN_ACCESSIBLE;
    else process.env.RIGYN_ACCESSIBLE = previous;
  }
});

test("TTY toggle picker uses a readable width when terminal columns are zero or invalid", async () => {
  for (const columns of [0, Number.NaN]) {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(mode: boolean): void;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode) => { input.isRaw = mode; };
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    output.isTTY = true;
    output.columns = columns;
    const rendered: Buffer[] = [];
    output.on("data", (chunk: Buffer) => rendered.push(Buffer.from(chunk)));
    const terminal = new TerminalController(input, output);

    const selection = terminal.chooseToggle("Project resources found", [
      { label: "Enable this workspace", value: true },
      { label: "Keep disabled for this launch", value: false },
    ], { initialIndex: 1 });
    input.write("\r");
    assert.equal(await selection, false);
    terminal.close();

    const text = Buffer.concat(rendered).toString("utf8");
    assert.match(text, /Project resources found/u);
    assert.match(text, /Keep disabled for this launch/u);
    assert.match(text, /Left\/Right choose · Enter select · Esc cancel/u);
  }
});

test("interactive event rendering closes the compaction lifecycle without exposing summary content", () => {
  const writes: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const renderer = new EventRenderer("interactive");
    renderer.render(envelope({
      type: "compaction_completed",
      summary: {
        id: "private-summary",
        role: "assistant",
        content: [{ type: "text", text: "SUMMARY_SENTINEL" }],
        createdAt: "2026-08-08T12:00:00.000Z",
      },
      sourceMessageIds: ["one", "two"],
      firstKeptMessageId: "two",
      tokensBefore: 12_500,
      estimatedTokensAfter: 4_200,
      reason: "threshold",
      fromExtension: false,
    }, 1));
    renderer.render(envelope({
      type: "compaction_failed",
      reason: "overflow",
      aborted: true,
      willRetry: false,
      errorMessage: "cancelled\n\x1b[31mprivate detail",
    }, 2));
  } finally {
    process.stderr.write = write;
  }

  const output = writes.join("");
  assert.match(output, /Context compacted · 2 messages · 12,500 tokens before/u);
  assert.match(output, /Compaction overflow cancelled · cancelled/u);
  assert.match(output, /\\x1b\[31mprivate detail/u);
  assert.doesNotMatch(output, /SUMMARY_SENTINEL|\x1b/u);
});

test("interactive event rendering redacts registered secrets from human diagnostics", () => {
  const writes: string[] = [];
  const write = process.stderr.write;
  const secret = "registered-event-renderer-secret";
  defaultSecretRedactor.register(secret);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const renderer = new EventRenderer("interactive");
    renderer.render(envelope({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 10,
      errorMessage: `summary-before-${secret}-after`,
    }, 1));
    renderer.render(envelope({
      type: "compaction_failed",
      reason: "overflow",
      aborted: false,
      willRetry: false,
      errorMessage: `compaction-before-${secret}-after`,
    }, 2));
    renderer.render(envelope({
      type: "warning",
      code: "registered-secret",
      message: `warning-before-${secret}-after`,
    }, 3));
  } finally {
    process.stderr.write = write;
  }

  const output = writes.join("");
  assert.doesNotMatch(output, new RegExp(secret, "u"));
  assert.match(output, /summary-before-\[REDACTED\]-after/u);
  assert.match(output, /compaction-before-\[REDACTED\]-after/u);
  assert.match(output, /warning-before-\[REDACTED\]-after/u);
});

test("terminal secret input preserves piped input behavior", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new TerminalController(input, output);
  const secret = terminal.readSecret("Secret: ");
  input.end("piped-secret\n");
  assert.equal(await secret, "piped-secret");
  assert.equal(output.readableLength, 0);
  terminal.close();
});

test("piped secret input is bounded and cancellable", async () => {
  const oversized = new PassThrough();
  const ignoredOutput = new PassThrough();
  const oversizedRead = readSecretFrom(oversized, ignoredOutput, "ignored");
  oversized.end(Buffer.alloc(64 * 1024 + 3, 97));
  await assert.rejects(oversizedRead, /exceeds 65536 bytes/u);

  const waiting = new PassThrough();
  const controller = new AbortController();
  const cancelled = readSecretFrom(waiting, ignoredOutput, "ignored", controller.signal);
  controller.abort(new Error("credential prompt cancelled"));
  await assert.rejects(cancelled, /credential prompt cancelled/u);
});

test("terminal prompts propagate hostile abort reasons without inspecting them", async () => {
  let traps = 0;
  const hostile = new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("prototype trap ran");
    },
    get() {
      traps += 1;
      throw new Error("property trap ran");
    },
  });
  const rejectedWith = async (promise: Promise<unknown>): Promise<{ cause: unknown }> => await promise.then(
    () => ({ cause: undefined }),
    (cause: unknown) => ({ cause }),
  );

  const questionInput = new PassThrough();
  const questionTerminal = new TerminalController(questionInput, new PassThrough());
  const questionAbort = new AbortController();
  const question = questionTerminal.question("Question: ", questionAbort.signal);
  questionAbort.abort(hostile);
  assert.equal((await rejectedWith(question)).cause, hostile);
  questionTerminal.close();

  const toggleInput = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
  toggleInput.isTTY = true;
  toggleInput.isRaw = false;
  toggleInput.setRawMode = (mode) => { toggleInput.isRaw = mode; };
  const toggleTerminal = new TerminalController(toggleInput, new PassThrough());
  const toggleAbort = new AbortController();
  const toggle = toggleTerminal.chooseToggle("Choose", [{ label: "One", value: 1 }], { signal: toggleAbort.signal });
  toggleAbort.abort(hostile);
  assert.equal((await rejectedWith(toggle)).cause, hostile);
  toggleTerminal.close();

  const pipedAbort = new AbortController();
  const piped = readSecretFrom(new PassThrough(), new PassThrough(), "Secret: ", pipedAbort.signal);
  pipedAbort.abort(hostile);
  assert.equal((await rejectedWith(piped)).cause, hostile);

  const secretInput = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(mode: boolean): void };
  secretInput.isTTY = true;
  secretInput.setRawMode = () => {};
  const secretAbort = new AbortController();
  const secret = readSecretFrom(secretInput, new PassThrough(), "Secret: ", secretAbort.signal);
  secretAbort.abort(hostile);
  assert.equal((await rejectedWith(secret)).cause, hostile);
  assert.equal(traps, 0);
});

test("TTY secret input preserves UTF-8 and backspaces one complete character", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(mode: boolean): void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  const secret = readSecretFrom(input, output, "Secret: ");
  input.write(Buffer.concat([Buffer.from("sëx", "utf8"), Buffer.from([127]), Buffer.from("cret\n", "utf8")]));
  assert.equal(await secret, "sëcret");
});

test("TTY secret prompt appears only after echo is disabled and input is ready", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(mode: boolean): void };
  input.isTTY = true;
  let raw = false;
  input.setRawMode = (mode) => { raw = mode; };
  const output = new PassThrough();
  let promptObserved = false;
  output.on("data", (chunk: Buffer) => {
    if (!chunk.toString("utf8").includes("Secret: ")) return;
    promptObserved = true;
    assert.equal(raw, true);
    assert.ok(input.listenerCount("data") > 0);
    input.write("hidden-value\n");
  });
  assert.equal(await readSecretFrom(input, output, "Secret: "), "hidden-value");
  assert.equal(promptObserved, true);
  assert.equal(raw, false);
});

test("TTY secret input cancels on Escape or Ctrl-C without revealing partial input", async () => {
  for (const key of [27, 3]) {
    const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(mode: boolean): void };
    input.isTTY = true;
    let raw = false;
    input.setRawMode = (mode) => { raw = mode; };
    const output = new PassThrough();
    const rendered: Buffer[] = [];
    output.on("data", (chunk: Buffer) => rendered.push(Buffer.from(chunk)));
    const secret = readSecretFrom(input, output, "Secret: ");
    input.write(Buffer.concat([Buffer.from("partial-secret"), Buffer.from([key])]));
    await assert.rejects(secret, /Secret input cancelled/u);
    assert.equal(raw, false);
    assert.doesNotMatch(Buffer.concat(rendered).toString("utf8"), /partial-secret/u);
  }
});

test("terminal secret input is hidden and ordinary questions resume in a PTY", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/terminal-secret.ts", import.meta.url));
  const command = [process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RIGYN_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64url"),
  };
  delete environment.OPENAI_API_KEY;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });

  await waitForOutput(() => rendered, "API key: ");
  const secret = "dummy-secret-never-render";
  child.stdin.write(`${secret}\n`);
  await waitForOutput(() => rendered, "Provider: ");
  child.stdin.write("openai\n");

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.doesNotMatch(rendered, new RegExp(secret, "u"));
  assert.match(rendered, /terminal-secret-complete/u);
});
