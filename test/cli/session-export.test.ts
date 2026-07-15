import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { SessionStore } from "../../src/storage/store.js";

async function runCli(argumentsValue: string[], environment: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/bin/rigyn.ts", ...argumentsValue], {
    cwd: resolve("."),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI subprocess timed out"));
    }, 10_000);
    child.once("error", reject);
    child.once("exit", (value) => {
      clearTimeout(timeout);
      resolveExit(value);
    });
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

test("CLI writes a redacted Markdown share copy and refuses redacted JSONL before file creation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-redacted-export-cli-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "private-workspace");
  const sessionDirectory = join(root, "sessions");
  const config = join(root, "config");
  const state = join(root, "state");
  await Promise.all([
    mkdir(workspace),
    mkdir(sessionDirectory),
    mkdir(join(config, "rigyn"), { recursive: true, mode: 0o700 }),
    mkdir(state),
  ]);
  const store = new SessionStore(join(sessionDirectory, "sessions.sqlite"));
  const thread = store.createThread({ threadId: "private-cli-thread-id", workspaceRoot: workspace });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "private-cli-message-id",
        role: "user",
        createdAt: "2040-05-06T07:08:09.123Z",
        content: [{
          type: "text",
          text: `Review ${workspace}/secret.ts using sk-proj-ABCDEFGHIJKLMNOP123456\0\u001b]0;PRIVATE_STDOUT_OSC\u0007\u001b[31mPRIVATE_STDOUT_CSI\u001b[0m`,
        }],
      },
    },
  });
  store.close();

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    NO_COLOR: "1",
  };
  delete environment.RIGYN_RECURSION_DEPTH;
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    delete environment[name];
  }

  const output = join(root, "share.md");
  const exported = await runCli([
    "--workspace", workspace,
    "--session-dir", sessionDirectory,
    "--export", output,
    "--redact",
    "--offline",
  ], environment);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(exported.stdout, "");
  const share = await readFile(output, "utf8");
  assert.match(share, /Redacted share copy; review before publishing\./u);
  assert.match(share, /Review \[WORKSPACE\]\/secret\.ts using \[REDACTED\]/u);
  assert.doesNotMatch(share, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u);
  assert.doesNotMatch(share, /private-cli-(?:thread|message)-id|2040-05-06|sk-proj-|private-workspace/u);

  const streamed = await runCli([
    "--workspace", workspace,
    "--session-dir", sessionDirectory,
    "--export", "-",
    "--redact",
    "--offline",
  ], environment);
  assert.equal(streamed.code, 0, streamed.stderr);
  assert.match(streamed.stdout, /Redacted share copy; review before publishing\./u);
  assert.match(streamed.stdout, /PRIVATE_STDOUT_OSC|PRIVATE_STDOUT_CSI/u);
  assert.doesNotMatch(streamed.stdout, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u);

  const jsonl = join(root, "must-not-exist", "share.jsonl");
  const refused = await runCli(["--export", jsonl, "--redact"], environment);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, "rigyn: Redacted exports support HTML or Markdown, not JSONL\n");
  await assert.rejects(access(jsonl), { code: "ENOENT" });
  await assert.rejects(access(join(root, "must-not-exist")), { code: "ENOENT" });
});
