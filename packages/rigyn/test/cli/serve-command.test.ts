import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  sessionV4ToolInputHash,
  type SessionV4RunSelection,
} from "@rigyn/kernel/session-v4";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import {
  assertLoopbackServeHost,
  runServeCommand,
} from "../../src/cli/serve-command.js";
import { parseManagementArguments } from "../../src/cli/management-args.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const TOKEN = `rigyn-serve-${"a".repeat(32)}`;
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const mainModule = pathToFileURL(
  fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
).href;

function createInterruptedServeSession(
  workspace: string,
  sessionDirectory: string,
): string {
  const sessionId = "serve-recovery";
  const manager = SessionManager.create(workspace, sessionDirectory, { id: sessionId });
  const timestamp = "2026-08-08T12:00:00.000Z";
  const operationId = "serve-recovery-operation";
  const promptNodeId = "serve-recovery-prompt";
  const assistantNodeId = "serve-recovery-assistant";
  const effectId = "serve-recovery-effect";
  const selection: SessionV4RunSelection = {
    provider: "serve-fixture",
    model: "serve-model",
    api: "openai-responses",
    thinkingLevel: "xhigh",
    toolNames: ["write"],
    toolsetFingerprint: "serve-recovery-toolset",
  };
  try {
    manager.commitChanges([{
      type: "run_accepted",
      branchId: "main",
      operationId,
      promptNodeId,
      sourceHeadId: null,
      acceptedAt: timestamp,
      request: { prompt: "resume after explicit recovery" },
      selection,
    }]);
    manager.appendMessage({
      id: promptNodeId,
      role: "user",
      content: [{ type: "text", text: "resume after explicit recovery" }],
      createdAt: timestamp,
    }, { nodeId: promptNodeId, operationId, parentId: null });
    manager.commitChanges([{
      type: "run_step_selected",
      operationId,
      step: 0,
      selectedAt: timestamp,
      selection,
    }, {
      type: "run_attempt",
      operationId,
      attemptId: "serve-recovery-attempt",
      step: 0,
      attempt: 1,
      task: "provider",
      startedAt: timestamp,
    }]);
    manager.appendMessage({
      id: assistantNodeId,
      role: "assistant",
      content: [{ type: "text", text: "Calling write" }],
      createdAt: timestamp,
    }, { nodeId: assistantNodeId, operationId, parentId: promptNodeId });
    const input = { path: "recovery.txt", content: "uncertain" };
    manager.commitChanges([{
      type: "tool_effect_prepared",
      effectId,
      operationId,
      invocationId: "serve-recovery-invocation",
      callId: "serve-recovery-call",
      toolName: "write",
      policy: "never_repeat",
      effectiveInput: input,
      inputHash: sessionV4ToolInputHash(input),
      resultNodeId: "serve-recovery-result",
      step: 0,
      index: 0,
      assistantNodeId,
      toolsetFingerprint: selection.toolsetFingerprint,
      preparedAt: timestamp,
    }, {
      type: "tool_effect_dispatched",
      effectId,
      dispatchId: "serve-recovery-dispatch",
      dispatchedAt: timestamp,
    }, {
      type: "run_cancel",
      operationId,
      cancelId: "serve-recovery-cancel",
      requestedAt: timestamp,
      reason: "caller cancelled before the tool result settled",
    }]);
  } finally {
    manager.closeV4Store();
  }
  return sessionId;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Test server did not expose a TCP port");
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else reject(error);
    });
  });
  return address.port;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
}

test("serve CLI accepts only explicit loopback hosts", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.doesNotThrow(() => assertLoopbackServeHost(host));
  }
  for (const host of ["0.0.0.0", "::", "192.0.2.1", "example.com", "LOCALHOST"]) {
    assert.throws(
      () => assertLoopbackServeHost(host),
      /--host must be 127\.0\.0\.1, localhost, or ::1/u,
    );
  }
});

test("serve CLI validates and globally redacts its bearer token before binding", async () => {
  await assert.rejects(
    runServeCommand(parseManagementArguments(["serve"]), { environment: {} }),
    /RIGYN_SERVE_TOKEN is required/u,
  );
  await assert.rejects(
    runServeCommand(parseManagementArguments(["serve"]), {
      environment: { RIGYN_SERVE_TOKEN: "too-short" },
    }),
    /RIGYN_SERVE_TOKEN is invalid/u,
  );
  await assert.rejects(
    runServeCommand(parseManagementArguments(["serve"]), {
      environment: { RIGYN_SERVE_TOKEN: `${"a".repeat(32)} with-space` },
    }),
    /RIGYN_SERVE_TOKEN is invalid/u,
  );

  await assert.rejects(
    runServeCommand(parseManagementArguments(["serve", "--host", "0.0.0.0"]), {
      environment: { RIGYN_SERVE_TOKEN: TOKEN },
    }),
    /rigyn serve does not provide TLS/u,
  );
  assert.equal(defaultSecretRedactor.redact(`token=${TOKEN}`), "token=[REDACTED]");
});

test("serve command starts offline, creates one canonical session, and stops cleanly", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-serve-command-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const sessionDirectory = join(root, "sessions");
  const entrypoint = join(root, "serve-entrypoint.mjs");
  const providerMarker = join(root, "provider-called");
  const extensionMarker = join(root, "extension-called");
  const replacementMarker = join(root, "replacement-called");
  const lifecycleMarker = join(root, "extension-lifecycle");
  const port = await unusedLoopbackPort();
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  const interruptedSessionId = createInterruptedServeSession(workspace, sessionDirectory);
  await writeFile(join(agentDirectory, "config.json"), `${JSON.stringify({
    defaultProvider: "serve-fixture",
    defaultModel: "serve-model",
    defaultThinkingLevel: "max",
  })}\n`);
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
let extensionGeneration = 0;
await main(${JSON.stringify([
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--workspace", workspace,
    "--session-dir", sessionDirectory,
    "--offline",
    "--no-extensions",
  ])}, {
  extensionFactories: [{
    name: "serve-fixture-provider",
    factory(rigyn) {
      const generation = ++extensionGeneration;
      rigyn.on("session_shutdown", (event) => {
        appendFileSync(${JSON.stringify(lifecycleMarker)}, generation + ":shutdown:" + event.reason + "\\n");
      });
      rigyn.onDispose(() => {
        appendFileSync(${JSON.stringify(lifecycleMarker)}, generation + ":dispose\\n");
        if (generation === 3) throw new Error("serve lifecycle cleanup fixture");
      });
      rigyn.registerCommand("serve-new-session", {
        async handler(_args, context) {
          appendFileSync(${JSON.stringify(replacementMarker)}, JSON.stringify(
            await context.newSession(),
          ) + "\\n");
        },
      });
      rigyn.on("input", (event, context) => {
        appendFileSync(${JSON.stringify(extensionMarker)}, JSON.stringify({
          mode: context.mode,
          source: event.source,
          text: event.text,
        }) + "\\n");
        return {
          action: "transform",
          text: event.text + " through direct extension",
          ...(event.images === undefined ? {} : { images: event.images }),
        };
      });
      rigyn.registerProvider("serve-fixture", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "serve-model",
          name: "Serve Model",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: "xhigh",
            max: null,
          },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* (_model, context) {
          appendFileSync(${JSON.stringify(providerMarker)}, JSON.stringify(context) + "\\n");
          yield { type: "response_start", model: "serve-model" };
          yield { type: "text_delta", part: 0, text: "served response" };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
        },
      });
    },
  }],
});
`);

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      RIGYN_HOME: agentDirectory,
      RIGYN_OFFLINE: "1",
      RIGYN_SERVE_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(
    () => stdout.includes(`rigyn serve listening at http://127.0.0.1:${port}`),
    "serve startup",
  );
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
  const health = await fetch(`http://127.0.0.1:${port}/health`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(health.status, 200);

  const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  const createdBody = JSON.parse(createdText) as {
    sessionId?: string;
    state?: {
      model?: { provider?: string; id?: string };
      thinkingLevel?: string;
    };
  };
  assert.equal(createdBody.state?.model?.provider, "serve-fixture");
  assert.equal(createdBody.state?.model?.id, "serve-model");
  assert.equal(createdBody.state?.thinkingLevel, "xhigh");
  const sessionPath = encodeURIComponent(createdBody.sessionId ?? "");

  const recoveryStatus = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}/recovery`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(recoveryStatus.status, 200);
  assert.deepEqual(await recoveryStatus.json(), {
    sessionId: createdBody.sessionId,
    suspendedRun: null,
  });

  const recovery = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}/recovery`,
    {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(recovery.status, 200);
  assert.deepEqual(await recovery.json(), {
    sessionId: createdBody.sessionId,
    recovery: { recovered: false, blocked: [] },
  });

  const replacement = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}/prompts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "/serve-new-session" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(replacement.status, 202, await replacement.text());
  await waitFor(async () => {
    try {
      return (await readFile(replacementMarker, "utf8")).trim() !== "";
    } catch {
      return false;
    }
  }, "serve extension replacement guard");
  assert.deepEqual(JSON.parse((await readFile(replacementMarker, "utf8")).trim()), {
    cancelled: true,
  });
  const identity = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(identity.status, 200);
  assert.equal((await identity.json() as { sessionId?: string }).sessionId, createdBody.sessionId);

  const prompted = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}/prompts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "reply through the fixture provider" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(prompted.status, 202, await prompted.text());
  try {
    await waitFor(async () => {
      try {
        return (await readFile(providerMarker, "utf8")).includes("through direct extension");
      } catch {
        return false;
      }
    }, "serve provider call");
  } catch (error) {
    throw new Error(`Serve provider did not run\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
      cause: error,
    });
  }
  const extensionCall = JSON.parse((await readFile(extensionMarker, "utf8")).trim()) as {
    mode?: string;
    source?: string;
    text?: string;
  };
  assert.deepEqual(extensionCall, {
    mode: "serve",
    source: "serve",
    text: "reply through the fixture provider",
  });
  assert.match(await readFile(providerMarker, "utf8"), /through direct extension/u);

  const opened = await fetch(`http://127.0.0.1:${port}/v1/sessions/open`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: interruptedSessionId }),
    signal: AbortSignal.timeout(30_000),
  });
  const openedText = await opened.text();
  assert.equal(opened.status, 200, openedText);
  assert.equal((JSON.parse(openedText) as {
    state?: { hasSuspendedRun?: boolean };
  }).state?.hasSuspendedRun, true);

  const interruptedPath = encodeURIComponent(interruptedSessionId);
  const interruptedStatus = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/recovery`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(interruptedStatus.status, 200);
  const interruptedStatusBody = await interruptedStatus.json() as {
    suspendedRun?: {
      operationId?: string;
      effects?: Array<{ effectId?: string; status?: string }>;
    };
  };
  assert.equal(interruptedStatusBody.suspendedRun?.operationId, "serve-recovery-operation");
  assert.deepEqual(interruptedStatusBody.suspendedRun?.effects, [{
    effectId: "serve-recovery-effect",
    callId: "serve-recovery-call",
    name: "write",
    policy: "never_repeat",
    status: "in_doubt",
    step: 0,
    index: 0,
    inputHash: sessionV4ToolInputHash({ path: "recovery.txt", content: "uncertain" }),
  }]);

  const resolved = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/recovery`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        resolutions: [{
          effectId: "serve-recovery-effect",
          outcome: "abandoned",
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const resolvedText = await resolved.text();
  assert.equal(resolved.status, 200, resolvedText);
  assert.deepEqual(JSON.parse(resolvedText), {
    sessionId: interruptedSessionId,
    recovery: {
      recovered: true,
      operationId: "serve-recovery-operation",
      blocked: [],
    },
  });

  const resumedPrompt = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/prompts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "recovered session is ready" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(resumedPrompt.status, 202, await resumedPrompt.text());
  await waitFor(async () => {
    try {
      return (await readFile(providerMarker, "utf8")).includes("recovered session is ready");
    } catch {
      return false;
    }
  }, "recovered serve provider call");

  const closed = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionPath}`, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(closed.status, 200, await closed.text());
  await waitFor(async () => {
    try {
      return (await readFile(lifecycleMarker, "utf8")).includes("1:dispose");
    } catch {
      return false;
    }
  }, "deleted serve session lifecycle");
  assert.deepEqual((await readFile(lifecycleMarker, "utf8")).trim().split("\n"), [
    "1:shutdown:quit",
    "1:dispose",
  ]);

  const closedAgain = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionPath}`, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(closedAgain.status, 404);
  assert.deepEqual((await readFile(lifecycleMarker, "utf8")).trim().split("\n"), [
    "1:shutdown:quit",
    "1:dispose",
  ]);

  const failureFixture = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  const failureFixtureText = await failureFixture.text();
  assert.equal(failureFixture.status, 201, failureFixtureText);
  const failureSessionId = (JSON.parse(failureFixtureText) as { sessionId?: string }).sessionId;
  assert.ok(failureSessionId);
  const failedClosure = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(failureSessionId)}`,
    { method: "DELETE", headers, signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(failedClosure.status, 500);
  assert.deepEqual(await failedClosure.json(), { error: "Internal server error" });
  await waitFor(async () => {
    try {
      return (await readFile(lifecycleMarker, "utf8")).includes("3:dispose");
    } catch {
      return false;
    }
  }, "failed serve cleanup containment");
  assert.deepEqual((await readFile(lifecycleMarker, "utf8")).trim().split("\n"), [
    "1:shutdown:quit",
    "1:dispose",
    "3:shutdown:quit",
    "3:dispose",
  ]);
  const failedClosureAgain = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(failureSessionId)}`,
    { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(failedClosureAgain.status, 404);

  assert.equal(child.kill("SIGTERM"), true);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Serve command did not stop\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 30_000);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal });
      });
    },
  );
  assert.deepEqual(exit, { code: 143, signal: null }, stderr);
  assert.deepEqual((await readFile(lifecycleMarker, "utf8")).trim().split("\n"), [
    "1:shutdown:quit",
    "1:dispose",
    "3:shutdown:quit",
    "3:dispose",
    "2:shutdown:quit",
    "2:dispose",
  ]);
  assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(TOKEN, "u"));
});
