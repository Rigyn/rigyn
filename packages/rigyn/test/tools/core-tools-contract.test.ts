import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CommandResult, CommandSpec, ProcessRunner } from "../../src/process/types.js";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import {
  createBashTool,
  createBashToolDefinition,
  createLocalBashOperations,
  EditTool,
  FindTool,
  GrepTool,
  LsTool,
  ReadTool,
  ShellTool,
  WorkspaceBoundary,
  WriteTool,
} from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";

async function fixture(options: { runner?: ProcessRunner } = {}): Promise<{
  root: string;
  context: ToolContext;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "harness-core-tools-"));
  return {
    root,
    context: {
      workspace: await WorkspaceBoundary.create(root),
      runner: options.runner ?? new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "run-core-tools",
      threadId: "thread-core-tools",
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function properties(tool: { definition: { inputSchema: unknown } }): string[] {
  const schema = tool.definition.inputSchema as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {}).sort();
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((selected) => { resolve = selected; });
  return { promise, resolve };
}

test("default core tool schemas expose a compact coding action space", () => {
  assert.deepEqual(properties(new ReadTool()), ["limit", "offset", "path"]);
  assert.deepEqual(properties(new WriteTool()), ["content", "path"]);
  assert.deepEqual(properties(new EditTool()), ["edits", "path"]);
  assert.deepEqual(properties(new ShellTool("bash")), ["command", "timeout"]);
});

test("core tool pagination parameters require safe integers in their documented ranges", () => {
  const invalid: Array<[string, { validate(input: never): void }, Record<string, unknown>]> = [
    ["read offset zero", new ReadTool(), { path: "file.txt", offset: 0 }],
    ["read limit zero", new ReadTool(), { path: "file.txt", limit: 0 }],
    ["read fractional limit", new ReadTool(), { path: "file.txt", limit: 1.5 }],
    ["find negative limit", new FindTool(), { pattern: "*.ts", limit: -1 }],
    ["ls fractional limit", new LsTool(), { limit: 1.5 }],
    ["grep negative context", new GrepTool(), { pattern: "value", context: -1 }],
    ["grep zero limit", new GrepTool(), { pattern: "value", limit: 0 }],
    ["grep unsafe limit", new GrepTool(), { pattern: "value", limit: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  for (const [label, tool, input] of invalid) {
    assert.throws(() => tool.validate(input as never), label);
  }
});

test("public bash factory exposes pluggable operations and spawn rewriting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-bash-factory-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  let received: { command: string; cwd: string; timeout?: number; marker?: string } | undefined;
  const definition = createBashToolDefinition(root, {
    spawnHook(context) {
      return { ...context, command: `prefix\n${context.command}`, env: { ...context.env, RIGYN_MARKER: "ready" } };
    },
    operations: {
      async exec(command, cwd, options) {
        received = {
          command,
          cwd,
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(options.env?.RIGYN_MARKER === undefined ? {} : { marker: options.env.RIGYN_MARKER }),
        };
        options.onData(Buffer.from("factory output", "utf8"));
        return { exitCode: 0 };
      },
    },
  });

  const result = await definition.execute("call-1", { command: "printf ok" }, undefined, undefined, undefined as never);
  assert.deepEqual(received, { command: "prefix\nprintf ok", cwd: root, marker: "ready" });
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "factory output");
  assert.deepEqual(Object.keys((definition.parameters as { properties: object }).properties).sort(), ["command", "timeout"]);
  assert.deepEqual(definition.promptGuidelines, [
    "Use the RIGYN_* session environment when exact current model, reasoning, or session details are needed.",
  ]);

  const failedDefinition = createBashToolDefinition(root, {
    operations: { async exec() { return { exitCode: 7 }; } },
  });
  await assert.rejects(
    async () => await failedDefinition.execute(
      "call-2",
      { command: "exit 7" },
      undefined,
      undefined,
      undefined as never,
    ),
    { message: "Shell command ended with status 7" },
  );
  const failedTool = createBashTool(root, {
    operations: { async exec() { return { exitCode: 7 }; } },
  });
  await assert.rejects(
    async () => await failedTool.execute("call-3", { command: "exit 7" }, undefined, undefined),
    { message: "Shell command ended with status 7" },
  );
});

test("public local bash operations reject a process signal with its real status", async (t) => {
  if (process.platform === "win32") {
    t.skip("The process-signal fixture requires a POSIX shell");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "rigyn-local-bash-signal-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const definition = createBashToolDefinition(root, { operations: createLocalBashOperations() });

  await assert.rejects(
    async () => await definition.execute(
      "signal-call",
      { command: "printf signal-preview; kill -TERM $$" },
      undefined,
      undefined,
      undefined as never,
    ),
    { message: "signal-preview\n\nShell command stopped after signal SIGTERM" },
  );
});

test("public local bash operations reject a completed timeout with its real status", async (t) => {
  if (process.platform === "win32") {
    t.skip("The real timeout fixture requires a POSIX shell");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "rigyn-local-bash-timeout-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const definition = createBashToolDefinition(root, { operations: createLocalBashOperations() });

  await assert.rejects(
    async () => await definition.execute(
      "timeout-call",
      { command: "printf timeout-preview; while :; do :; done", timeout: 0.02 },
      undefined,
      undefined,
      undefined as never,
    ),
    { message: "timeout-preview\n\nShell command exceeded its 0.02-second time limit" },
  );
});

test("bash exposes current non-secret session metadata and supports a strict opt-out", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const names = [
    "RIGYN_SESSION_ID",
    "RIGYN_SESSION_FILE",
    "RIGYN_PROVIDER",
    "RIGYN_MODEL",
    "RIGYN_REASONING_LEVEL",
  ] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = `stale-${name.toLowerCase()}`;
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const environments: NodeJS.ProcessEnv[] = [];
  const operations = {
    async exec(
      _command: string,
      _cwd: string,
      options: { onData(data: Buffer): void; env?: NodeJS.ProcessEnv },
    ) {
      environments.push({ ...options.env });
      return { exitCode: 0 };
    },
  };
  const enabled = new ShellTool("bash", { operations });
  await enabled.execute({ command: "first" }, {
    ...workspace.context,
    threadId: "session-current",
    sessionFile: "/sessions/current.jsonl",
    provider: "provider-current",
    modelId: "model-current",
    reasoningLevel: "xhigh",
  });
  await enabled.execute({ command: "second" }, {
    ...workspace.context,
    threadId: "session-next",
  });
  const disabled = new ShellTool("bash", { operations, exposeSessionEnvironment: false });
  await disabled.execute({ command: "third" }, {
    ...workspace.context,
    threadId: "session-hidden",
    provider: "provider-hidden",
    modelId: "model-hidden",
  });
  const legacyDisabled = new ShellTool("bash", { operations, sessionEnvironment: false });
  await legacyDisabled.execute({ command: "fourth" }, {
    ...workspace.context,
    threadId: "legacy-session-hidden",
  });

  assert.deepEqual(
    Object.fromEntries(names.map((name) => [name, environments[0]?.[name]])),
    {
      RIGYN_SESSION_ID: "session-current",
      RIGYN_SESSION_FILE: "/sessions/current.jsonl",
      RIGYN_PROVIDER: "provider-current",
      RIGYN_MODEL: "model-current",
      RIGYN_REASONING_LEVEL: "xhigh",
    },
  );
  assert.deepEqual(
    Object.fromEntries(names.map((name) => [name, environments[1]?.[name]])),
    {
      RIGYN_SESSION_ID: "session-next",
      RIGYN_SESSION_FILE: undefined,
      RIGYN_PROVIDER: undefined,
      RIGYN_MODEL: undefined,
      RIGYN_REASONING_LEVEL: undefined,
    },
  );
  assert.equal(names.every((name) => environments[2]?.[name] === undefined), true);
  assert.equal(names.every((name) => environments[3]?.[name] === undefined), true);
  assert.equal(
    createBashToolDefinition(workspace.root, { exposeSessionEnvironment: false }).promptGuidelines,
    undefined,
  );
});

test("bash scrubs inherited credentials before injecting current session metadata", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const inherited = {
    PATH: "/usr/bin:/bin",
    SAFE_BUILD_FLAG: "ordinary-build-value",
    OPENCODE_GO_API_KEY: "opencode-go-shell-scrub-secret",
    SERVICE_AUTH_TOKEN: "generic-token-shell-scrub-secret",
    BUILD_PASSWORD: "generic-password-shell-scrub-secret",
    PGPASSWORD: "postgres-password-shell-scrub-secret",
    MYSQL_PWD: "mysql-password-shell-scrub-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google-credentials-shell-scrub-secret.json",
    DATABASE_URL: "postgres://shell-user:shell-password@example.test/database",
    PASSWORDLESS_BUILD_MODE: "enabled",
    RIGYN_SESSION_ID: "stale-session-id",
    RIGYN_PROVIDER: "stale-provider",
  } as const;
  const original = new Map(Object.keys(inherited).map((name) => [name, process.env[name]]));
  Object.assign(process.env, inherited);
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  let environment: NodeJS.ProcessEnv | undefined;
  let hookEnvironment: NodeJS.ProcessEnv | undefined;
  await new ShellTool("bash", {
    spawnHook(context) {
      hookEnvironment = { ...context.env };
      return {
        ...context,
        env: { ...context.env, OPENCODE_GO_API_KEY: "trusted-hook-reintroduced-secret" },
      };
    },
    operations: {
      async exec(_command, _cwd, options) {
        environment = { ...options.env };
        return { exitCode: 0 };
      },
    },
  }).execute({ command: "inspect environment" }, {
    ...workspace.context,
    threadId: "current-session-id",
    provider: "current-provider",
  });

  assert.equal(
    Object.entries(environment ?? {}).find(([name]) => name.toLowerCase() === "path")?.[1],
    inherited.PATH,
  );
  assert.equal(environment?.SAFE_BUILD_FLAG, inherited.SAFE_BUILD_FLAG);
  assert.equal(environment?.PASSWORDLESS_BUILD_MODE, inherited.PASSWORDLESS_BUILD_MODE);
  assert.equal(hookEnvironment?.OPENCODE_GO_API_KEY, undefined);
  assert.equal(environment?.OPENCODE_GO_API_KEY, "trusted-hook-reintroduced-secret");
  assert.equal(environment?.SERVICE_AUTH_TOKEN, undefined);
  assert.equal(environment?.BUILD_PASSWORD, undefined);
  assert.equal(environment?.PGPASSWORD, undefined);
  assert.equal(environment?.MYSQL_PWD, undefined);
  assert.equal(environment?.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(environment?.DATABASE_URL, undefined);
  assert.equal(environment?.RIGYN_SESSION_ID, "current-session-id");
  assert.equal(environment?.RIGYN_PROVIDER, "current-provider");
  for (const value of [
    inherited.OPENCODE_GO_API_KEY,
    inherited.SERVICE_AUTH_TOKEN,
    inherited.BUILD_PASSWORD,
    inherited.PGPASSWORD,
    inherited.MYSQL_PWD,
    inherited.GOOGLE_APPLICATION_CREDENTIALS,
    inherited.DATABASE_URL,
  ]) {
    assert.equal(defaultSecretRedactor.redact(value), "[REDACTED]");
  }
});

test("read accepts absolute paths and returns raw text with offset/limit continuation", async (t) => {
  const workspace = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "harness-read-outside-"));
  t.after(async () => {
    await workspace.close();
    await rm(outside, { recursive: true, force: true });
  });
  const path = join(outside, "docs.txt");
  await writeFile(path, "one\ntwo\nthree\n", "utf8");

  const result = await new ReadTool().execute({ path, offset: 2, limit: 1 }, workspace.context);
  assert.equal(result.content, "two\n\n[2 lines remain. Continue at offset=3.]");
  assert.doesNotMatch(result.content, /\d+ \|/u);
});

test("write creates missing parents for relative and absolute paths without extra flags", async (t) => {
  const workspace = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "harness-write-outside-"));
  t.after(async () => {
    await workspace.close();
    await rm(outside, { recursive: true, force: true });
  });

  await new WriteTool().execute({ path: "nested/relative.txt", content: "relative\n" }, workspace.context);
  const absolute = join(outside, "nested", "absolute.txt");
  await new WriteTool().execute({ path: absolute, content: "absolute\n" }, workspace.context);

  assert.equal(await readFile(join(workspace.root, "nested", "relative.txt"), "utf8"), "relative\n");
  assert.equal(await readFile(absolute, "utf8"), "absolute\n");
});

test("write reports the UTF-8 byte count in its success text and metadata", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());

  const result = await new WriteTool().execute({ path: "unicode.txt", content: "é" }, workspace.context);

  assert.equal(result.content, "Successfully wrote 2 bytes to unicode.txt");
  assert.deepEqual(result.metadata, { path: "unicode.txt", bytes: 2 });
});

test("edit accepts absolute paths and applies unique disjoint edits against the original", async (t) => {
  const workspace = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "harness-edit-outside-"));
  t.after(async () => {
    await workspace.close();
    await rm(outside, { recursive: true, force: true });
  });
  const path = join(outside, "sample.txt");
  await writeFile(path, "console.log(‘hello’);\nkeep   \n", "utf8");

  await new EditTool().execute({
    path,
    edits: [
      { oldText: "console.log('hello');", newText: "console.log('world');" },
      { oldText: "keep\n", newText: "kept\n" },
    ],
  }, workspace.context);

  assert.equal(await readFile(path, "utf8"), "console.log('world');\nkept\n");
});

test("bash uses seconds for timeout, runs at the session cwd, and returns unlabelled combined output", async (t) => {
  let received: CommandSpec | undefined;
  const runner: ProcessRunner = {
    async run(spec): Promise<CommandResult> {
      received = spec;
      spec.onOutput?.("stdout", Buffer.from("first\n"));
      spec.onOutput?.("stderr", Buffer.from("second\n"));
      return {
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBytes: 6,
        stderrBytes: 7,
        timedOut: false,
        cancelled: false,
        durationMs: 3,
      };
    },
  };
  const workspace = await fixture({ runner });
  t.after(async () => await workspace.close());

  const result = await new ShellTool("bash").execute({ command: "ignored", timeout: 2 }, workspace.context);
  assert.equal(received?.cwd, workspace.root);
  assert.equal(received?.timeoutMs, 2_000);
  assert.equal(result.content, "first\nsecond\n");
  assert.doesNotMatch(result.content, /stdout:|stderr:|Command exited/u);
});

test("bash retains the complete bounded-output artifact when execution times out", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const output = `${Array.from({ length: 3_000 }, (_, index) => `timeout-line-${index + 1}`).join("\n")}\n`;
  const tool = new ShellTool("bash", {
    operations: {
      async exec(_command, _cwd, { onData }) {
        onData(Buffer.from(output));
        throw new Error("timeout:0.05");
      },
    },
  });

  const result = await tool.execute({ command: "fixture", timeout: 0.05 }, workspace.context);
  assert.equal(result.isError, true);
  assert.match(result.content, /Shell command exceeded its 0\.05-second time limit/u);
  assert.equal((result.metadata as Record<string, unknown>).timedOut, true);
  assert.equal((result.metadata as Record<string, unknown>).cancelled, false);
  const artifact = /Complete output: ([^\]\n]+)/u.exec(result.content)?.[1];
  assert.notEqual(artifact, undefined);
  const stored = await readFile(artifact!, "utf8");
  assert.match(stored, /^timeout-line-1\ntimeout-line-2\n/u);
  assert.match(stored, /timeout-line-2999\ntimeout-line-3000\n$/u);
  t.after(async () => await rm(artifact!, { force: true }));
});

test("bash converts a compatibility cancellation sentinel without masking a real abort", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const tool = new ShellTool("bash", {
    operations: {
      async exec(_command, _cwd, { onData }) {
        onData(Buffer.from("partial output"));
        throw new Error("aborted");
      },
    },
  });

  const result = await tool.execute({ command: "fixture" }, workspace.context);
  assert.equal(result.isError, true);
  assert.match(result.content, /^Tool failed: partial output[\s\S]*Shell command was cancelled$/u);
  assert.equal((result.metadata as Record<string, unknown>).cancelled, true);
  assert.equal((result.metadata as Record<string, unknown>).timedOut, false);

  const controller = new AbortController();
  controller.abort(new Error("real abort"));
  await assert.rejects(
    tool.execute({ command: "fixture" }, { ...workspace.context, signal: controller.signal }),
    /real abort/u,
  );
});

test("bash reports an operations-owned timeout without inventing a timeout value", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const result = await new ShellTool("bash", {
    operations: {
      async exec() {
        return { exitCode: null, timedOut: true };
      },
    },
  }).execute({ command: "fixture" }, workspace.context);

  assert.equal(result.isError, true);
  assert.match(result.content, /Shell command timed out$/u);
  assert.doesNotMatch(result.content, /undefined-second/u);
});

test("bash prepends the configured shell source in the existing invocation", async (t) => {
  let received: CommandSpec | undefined;
  const runner: ProcessRunner = {
    async run(spec): Promise<CommandResult> {
      received = spec;
      return { exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutBytes: 0, stderrBytes: 0, timedOut: false, cancelled: false, durationMs: 1 };
    },
  };
  const workspace = await fixture({ runner });
  t.after(async () => await workspace.close());
  await new ShellTool("bash", { commandPrefix: "source ~/.profile" }).execute({ command: "printf ready" }, workspace.context);
  assert.match(received?.argv.at(-1) ?? "", /source ~\/\.profile\nprintf ready/u);
});

test("bash leaves omitted timeouts unbounded until cancellation", async (t) => {
  let received: CommandSpec | undefined;
  const runner: ProcessRunner = {
    async run(spec): Promise<CommandResult> {
      received = spec;
      return {
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBytes: 0,
        stderrBytes: 0,
        timedOut: false,
        cancelled: false,
        durationMs: 1,
      };
    },
  };
  const workspace = await fixture({ runner });
  t.after(async () => await workspace.close());

  const result = await new ShellTool("bash").execute({ command: "ignored" }, workspace.context);
  assert.equal(received?.timeoutMs, undefined);
  assert.equal(result.content, "(no output)");
  assert.equal(result.isError, false);
});

test("bash returns a metadata-complete error result for non-zero exits and ignores output callbacks after settlement", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  let emitLate: (() => void) | undefined;
  const successful = new ShellTool("bash", {
    operations: {
      async exec(_command, _cwd, { onData }) {
        onData(Buffer.from("before\n"));
        emitLate = () => onData(Buffer.from("late\n"));
        return { exitCode: 0 };
      },
    },
  });
  const result = await successful.execute({ command: "ignored" }, workspace.context);
  emitLate?.();
  assert.equal(result.content, "before\n");

  const failed = new ShellTool("bash", {
    operations: { async exec() { return { exitCode: 7 }; } },
  });
  const failure = await failed.execute({ command: "ignored" }, workspace.context);
  assert.equal(failure.isError, true);
  assert.equal(failure.status, "error");
  assert.equal(failure.content, "Tool failed: Shell command ended with status 7");
  assert.equal((failure.metadata as Record<string, unknown> | undefined)?.exitCode, 7);
});

test("read truncates at 2,000 complete lines and provides an exact offset", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const lines = Array.from({ length: 2_500 }, (_, index) => `line-${index + 1}`);
  await writeFile(join(workspace.root, "large.txt"), lines.join("\n"), "utf8");

  const first = await new ReadTool().execute({ path: "large.txt" }, workspace.context);
  assert.match(first.content, /^line-1\n/u);
  assert.match(first.content, /\nline-2000\n\n\[Returned lines 1-2000 of 2500\. Continue at offset=2001\.\]$/u);
  assert.doesNotMatch(first.content, /line-2001/u);

  const rest = await new ReadTool().execute({ path: "large.txt", offset: 2001 }, workspace.context);
  assert.match(rest.content, /^line-2001\n/u);
  assert.match(rest.content, /line-2500$/u);
});

test("read never returns a partial ordinary line or executable advice for one oversized line", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const line = "é".repeat(30_000);
  await writeFile(join(workspace.root, "wide.txt"), `${line}\nafter\n`, "utf8");

  const first = await new ReadTool().execute({ path: "wide.txt" }, workspace.context);
  assert.equal(first.content, "[Line 1 is 58.6KB, above the 50.0KB read limit.]");
  assert.doesNotMatch(first.content, /�/u);
  const rest = await new ReadTool().execute({ path: "wide.txt", offset: 2 }, workspace.context);
  assert.equal(rest.content, "after\n");
});

test("read oversized-line diagnostics do not echo shell metacharacters from paths", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const requested = "wide ; $(touch marker) 'quoted'.txt";
  const tool = new ReadTool({
    operations: {
      async access() {},
      async readFile() { return Buffer.from("é".repeat(30_000), "utf8"); },
    },
  });

  const result = await tool.execute({ path: requested }, workspace.context);
  assert.equal(result.content, "[Line 1 is 58.6KB, above the 50.0KB read limit.]");
  assert.doesNotMatch(result.content, /sed|head|touch|marker|quoted/u);
});

test("bash keeps the final 2,000 lines and persists complete truncated output", async (t) => {
  const output = Buffer.from(Array.from({ length: 3_000 }, (_, index) => String(index + 1)).join("\n") + "\n");
  const selected: ProcessRunner = {
    async run(spec): Promise<CommandResult> {
      for (let offset = 0; offset < output.byteLength; offset += 137) {
        spec.onOutput?.("stdout", output.subarray(offset, Math.min(output.byteLength, offset + 137)));
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBytes: output.byteLength,
        stderrBytes: 0,
        timedOut: false,
        cancelled: false,
        durationMs: 5,
      };
    },
  };
  const workspace = await fixture({ runner: selected });
  t.after(async () => await workspace.close());

  const result = await new ShellTool("bash").execute({ command: "seq 3000" }, workspace.context);
  assert.match(result.content, /^1001\n1002\n/u);
  assert.match(result.content, /2999\n3000\n\n\[Tail contains lines 1001-3000 of 3000\. Complete output: /u);
  assert.doesNotMatch(result.content, /^1\n/u);
  const fullOutputPath = (result.metadata as { fullOutputPath?: string }).fullOutputPath;
  assert.ok(fullOutputPath);
  assert.equal(await readFile(fullOutputPath, "utf8"), output.toString("utf8"));
  await rm(fullOutputPath, { force: true });
});

test("bash reports the size of a newline-terminated oversized final line", async (t) => {
  const output = Buffer.from(`${"x".repeat(60_000)}\n`);
  const selected: ProcessRunner = {
    async run(spec): Promise<CommandResult> {
      for (let offset = 0; offset < output.byteLength; offset += 137) {
        spec.onOutput?.("stdout", output.subarray(offset, Math.min(output.byteLength, offset + 137)));
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBytes: output.byteLength,
        stderrBytes: 0,
        timedOut: false,
        cancelled: false,
        durationMs: 5,
      };
    },
  };
  const workspace = await fixture({ runner: selected });
  t.after(async () => await workspace.close());

  const result = await new ShellTool("bash").execute({ command: "fixture" }, workspace.context);
  assert.match(
    result.content,
    /\[Tail contains 50\.0KB from line 1; complete line size is 58\.6KB\. Complete output: /u,
  );
  const fullOutputPath = (result.metadata as { fullOutputPath?: string }).fullOutputPath;
  assert.ok(fullOutputPath);
  await rm(fullOutputPath, { force: true });
});

test("edit and write serialize aliases of the same physical file", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const path = join(workspace.root, "shared.txt");
  const alias = join(workspace.root, "shared-alias.txt");
  await writeFile(path, "alpha\nbeta\n", "utf8");
  await symlink(path, alias);
  const edit = new EditTool();

  await Promise.all([
    edit.execute({ path, edits: [{ oldText: "alpha", newText: "ALPHA" }] }, workspace.context),
    edit.execute({ path: alias, edits: [{ oldText: "beta", newText: "BETA" }] }, workspace.context),
  ]);
  assert.equal(await readFile(path, "utf8"), "ALPHA\nBETA\n");
});

test("an aborted write retains its mutation lane until the underlying write settles", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const path = join(workspace.root, "ordered-write.txt");
  const started = deferred();
  const release = deferred();
  let writes = 0;
  const tool = new WriteTool({
    operations: {
      async mkdir() {},
      async writeFile(target, content) {
        writes += 1;
        if (writes === 1) {
          started.resolve();
          await release.promise;
        }
        await writeFile(target, content, "utf8");
      },
    },
  });
  const controller = new AbortController();
  const first = tool.execute({ path, content: "first" }, { ...workspace.context, signal: controller.signal });
  await started.promise;
  controller.abort();
  const second = tool.execute({ path, content: "second" }, workspace.context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);

  release.resolve();
  await Promise.all([first, second]);
  assert.equal(writes, 2);
  assert.equal(await readFile(path, "utf8"), "second");
});

test("an aborted edit retains its mutation lane until the underlying write settles", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const path = join(workspace.root, "ordered-edit.txt");
  await writeFile(path, "alpha\nbeta\n", "utf8");
  const started = deferred();
  const release = deferred();
  let writes = 0;
  const tool = new EditTool({
    operations: {
      async access() {},
      async readFile(target) { return await readFile(target); },
      async writeFile(target, content) {
        writes += 1;
        if (writes === 1) {
          started.resolve();
          await release.promise;
        }
        await writeFile(target, content, "utf8");
      },
    },
  });
  const controller = new AbortController();
  const first = tool.execute({
    path,
    edits: [{ oldText: "alpha", newText: "ALPHA" }],
  }, { ...workspace.context, signal: controller.signal });
  await started.promise;
  controller.abort();
  const second = tool.execute({
    path,
    edits: [{ oldText: "beta", newText: "BETA" }],
  }, workspace.context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);

  release.resolve();
  await Promise.all([first, second]);
  assert.equal(writes, 2);
  assert.equal(await readFile(path, "utf8"), "ALPHA\nBETA\n");
});

test("direct bash inherits ordinary environment variables", async (t) => {
  const workspace = await fixture();
  t.after(async () => await workspace.close());
  const previous = process.env.HARNESS_TEST_ENV;
  const previousSecret = process.env.HARNESS_TEST_API_KEY;
  const previousPostgresPassword = process.env.PGPASSWORD;
  const previousMysqlPassword = process.env.MYSQL_PWD;
  const previousCredentials = process.env.HARNESS_TEST_CREDENTIALS;
  process.env.HARNESS_TEST_ENV = "visible-to-command";
  process.env.HARNESS_TEST_API_KEY = "direct-child-shell-secret";
  process.env.PGPASSWORD = "direct-child-postgres-secret";
  process.env.MYSQL_PWD = "direct-child-mysql-secret";
  process.env.HARNESS_TEST_CREDENTIALS = "direct-child-credentials-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.HARNESS_TEST_ENV;
    else process.env.HARNESS_TEST_ENV = previous;
    if (previousSecret === undefined) delete process.env.HARNESS_TEST_API_KEY;
    else process.env.HARNESS_TEST_API_KEY = previousSecret;
    if (previousPostgresPassword === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = previousPostgresPassword;
    if (previousMysqlPassword === undefined) delete process.env.MYSQL_PWD;
    else process.env.MYSQL_PWD = previousMysqlPassword;
    if (previousCredentials === undefined) delete process.env.HARNESS_TEST_CREDENTIALS;
    else process.env.HARNESS_TEST_CREDENTIALS = previousCredentials;
  });

  const result = await new ShellTool("bash").execute({
    command: "printf '%s|%s|%s|%s|%s|%s' \"$HARNESS_TEST_ENV\" \"${HARNESS_TEST_API_KEY-unset}\" \"${PGPASSWORD-unset}\" \"${MYSQL_PWD-unset}\" \"${HARNESS_TEST_CREDENTIALS-unset}\" \"$RIGYN_SESSION_ID\"",
  }, workspace.context);
  assert.equal(result.content, "visible-to-command|unset|unset|unset|unset|thread-core-tools");
});
