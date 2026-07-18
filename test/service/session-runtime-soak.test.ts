import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { StoredConversation } from "../../src/service/session-runtime.js";
import { SessionStore } from "../../src/storage/store.js";

function appendMessages(store: SessionStore, threadId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    store.appendEvent({
      threadId,
      event: {
        type: "message_appended",
        message: {
          id: `message-${index}`,
          role: index % 2 === 0 ? "user" : "assistant",
          createdAt: "2026-07-18T00:00:00.000Z",
          content: [{ type: "text", text: `message ${index}` }],
        },
      },
    });
  }
}

test("a long session survives twenty-five complete close and resume cycles", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-resume-soak-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "sessions.sqlite");
  const writer = new SessionStore(path);
  writer.createThread({ threadId: "long-session", workspaceRoot: root });
  appendMessages(writer, "long-session", 1_000);
  writer.close();

  for (let iteration = 0; iteration < 25; iteration += 1) {
    const reopened = new SessionStore(path);
    const contextValue = await new StoredConversation(reopened).loadContext(
      "long-session",
      "main",
      "fixture",
      new AbortController().signal,
    );
    assert.equal(contextValue.messages.length, 1_000);
    assert.equal(contextValue.messages[0]?.id, "message-0");
    assert.equal(contextValue.messages.at(-1)?.id, "message-999");
    reopened.close();
  }
});

test("a session database resumes after its writer is abnormally terminated", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-crash-soak-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "sessions.sqlite");
  const ready = join(root, "ready");
  const source = `
    import { writeFileSync } from "node:fs";
    import { SessionStore } from "./src/storage/store.ts";
    const store = new SessionStore(${JSON.stringify(path)});
    store.createThread({ threadId: "crashed-session", workspaceRoot: ${JSON.stringify(root)} });
    for (let index = 0; index < 256; index += 1) {
      store.appendEvent({
        threadId: "crashed-session",
        event: {
          type: "message_appended",
          message: {
            id: "crash-message-" + index,
            role: "user",
            createdAt: "2026-07-18T00:00:00.000Z",
            content: [{ type: "text", text: "message " + index }],
          },
        },
      });
    }
    writeFileSync(${JSON.stringify(ready)}, "ready");
    setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: resolve("."),
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(Buffer.from(chunk)));
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      if (await readFile(ready, "utf8") === "ready") break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`session writer exited before readiness: ${Buffer.concat(errors).toString("utf8")}`);
    }
    if (Date.now() >= deadline) assert.fail("session writer did not become ready");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolveExit());
  });

  const reopened = new SessionStore(path);
  const contextValue = await new StoredConversation(reopened).loadContext(
    "crashed-session",
    "main",
    "fixture",
    new AbortController().signal,
  );
  assert.equal(contextValue.messages.length, 256);
  assert.equal(contextValue.messages.at(-1)?.id, "crash-message-255");
  reopened.close();

  await assert.rejects(access(`${path}-wal`), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  await assert.rejects(access(`${path}-shm`), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});
