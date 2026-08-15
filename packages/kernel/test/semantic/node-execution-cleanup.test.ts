import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeExecutionEnv } from "../../src/node.js";

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

test("NodeExecutionEnv cleanup terminates active shell processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-node-cleanup-"));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(async () => {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const marker = `started-${iteration}`;
    const execution = env.exec(nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)},"");setTimeout(()=>{},60000)`));
    let executionSettled = false;
    void execution.then(() => { executionSettled = true; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const started = await env.exists(marker);
      if (started.ok && started.value) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(await env.exists(marker), { ok: true, value: true });

    const cleanupStartedAt = performance.now();
    await env.cleanup();
    assert.equal(performance.now() - cleanupStartedAt < 3_000, true, "cleanup did not settle promptly");
    await Promise.resolve();
    assert.equal(executionSettled, true, "cleanup returned before its active shell settled");
    let timeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("active shell did not settle after cleanup")), 3_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    assert.equal(result.ok, true);
  }
});

test("NodeExecutionEnv cleanup terminates descendants after their shell exits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-node-descendant-cleanup-"));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(async () => {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  const marker = "descendant-started";
  const survived = "descendant-survived-cleanup";
  const source = [
    `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},""),100)`,
    `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(survived)},""),750)`,
    "setTimeout(()=>{},60000)",
  ].join(";");
  const execution = env.exec(process.platform === "win32"
    ? `start "" /b ${nodeCommand(source)}`
    : `${nodeCommand(source)} &`);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const started = await env.exists(marker);
    if (started.ok && started.value) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(await env.exists(marker), { ok: true, value: true });

  let cleanupTimeout: NodeJS.Timeout | undefined;
  await Promise.race([
    env.cleanup(),
    new Promise<never>((_resolve, reject) => {
      cleanupTimeout = setTimeout(() => reject(new Error("cleanup left a descendant holding the shell pipes")), 3_000);
    }),
  ]).finally(() => {
    if (cleanupTimeout) clearTimeout(cleanupTimeout);
  });
  assert.equal((await execution).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.deepEqual(await env.exists(survived), { ok: true, value: false }, "cleanup left its descendant running");
});

test("NodeExecutionEnv preserves Windows shell exits and classifies launcher failures", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-node-launcher-protocol-"));
  const env = new NodeExecutionEnv({ cwd: root });
  t.after(async () => {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(await env.exec("exit /b 125"), {
    ok: true,
    value: { stdout: "", stderr: "", exitCode: 125 },
  });
  const rejected = await new NodeExecutionEnv({
    cwd: root,
    shellPath: `rigyn-missing-shell-${process.pid}-${Date.now()}.exe`,
  }).exec("exit /b 0");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "spawn_error");
});
