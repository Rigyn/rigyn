import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getExtensionRuntimeHost } from "../../src/extensions/compat.js";
import type { ExtensionConfigSnapshot } from "../../src/extensions/config-store.js";
import type { ExtensionAPI } from "../../src/extensions/direct.js";
import type { ExtensionProcessId } from "../../src/process/managed-process.js";

interface GenerationProbe {
  readonly api: ExtensionAPI;
  readonly stagedConfig: ExtensionConfigSnapshot;
  readonly stagedConfigError: string;
  readonly stagedProcessError: string;
  start(script: string, stdin?: "ignore" | "pipe"): ExtensionProcessId;
}

function extensionSource(key: string, generation: number): string {
  return `
    import type { ExtensionAPI } from "rigyn/extensions";

    export default async function activate(rigyn: ExtensionAPI): Promise<void> {
      const stagedConfig = await rigyn.config.read("workspace");
      let stagedConfigError = "";
      try {
        await rigyn.config.replace(
          "workspace",
          { illegalGeneration: ${generation} },
          { expectedRevision: stagedConfig.revision },
        );
      } catch (error) {
        stagedConfigError = error instanceof Error ? error.message : String(error);
      }

      let stagedProcessError = "";
      try {
        rigyn.processes.spawn({
          argv: [process.execPath, "--version"],
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch (error) {
        stagedProcessError = error instanceof Error ? error.message : String(error);
      }

      const state = globalThis as Record<string, unknown>;
      const probes = Array.isArray(state[${JSON.stringify(key)}]) ? state[${JSON.stringify(key)}] : [];
      state[${JSON.stringify(key)}] = probes;
      probes.push({
        api: rigyn,
        stagedConfig,
        stagedConfigError,
        stagedProcessError,
        start(script: string, stdin: "ignore" | "pipe" = "ignore") {
          return rigyn.processes.spawn({
            argv: [process.execPath, "--eval", script],
            stdin,
            stdout: "pipe",
            stderr: "ignore",
            timeoutMs: 10_000,
          });
        },
      });
    }
  `;
}

function probes(key: string): GenerationProbe[] {
  const value = (globalThis as Record<string, unknown>)[key];
  assert.ok(Array.isArray(value));
  return value as GenerationProbe[];
}

async function readPipe(
  api: ExtensionAPI,
  id: ExtensionProcessId,
  maximum: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (;;) {
    const page = await api.processes.read(id, "stdout", { maxBytes: maximum });
    assert.ok(page.data.byteLength <= maximum);
    chunks.push(Buffer.from(page.data));
    if (page.eof) return Buffer.concat(chunks);
  }
}

async function readPid(api: ExtensionAPI, id: ExtensionProcessId): Promise<number> {
  const bytes = await api.processes.read(id, "stdout", { maxBytes: 64 });
  const pid = Number(Buffer.from(bytes.data).toString("utf8").trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  return pid;
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise<void>((resolveValue) => setTimeout(resolveValue, 20));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  assert.fail(`managed process ${pid} survived generation disposal`);
}

test("a public-only extension composes durable config with generation-owned processes", { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-extension-foundation-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sourcePath = join(workspace, "foundation.ts");
  const key = `__rigynExtensionFoundation${Date.now()}${Math.random().toString(16).slice(2)}`;
  const echoScript = [
    `process.stdin.on("data", (chunk) => process.stdout.write(Buffer.from(chunk).toString("utf8").toUpperCase()))`,
    `process.stdin.on("end", () => process.exit(0))`,
  ].join(";");
  const longScript = `process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1_000)`;
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(sourcePath, extensionSource(key, 1));

  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [sourcePath],
  });
  context.after(async () => {
    await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close().catch(() => undefined);
    delete (globalThis as Record<string, unknown>)[key];
    await rm(root, { recursive: true, force: true });
  });

  await loader.refresh();
  const first = probes(key)[0]!;
  assert.deepEqual(first.stagedConfig, { revision: null, value: undefined });
  assert.match(first.stagedConfigError, /not writable/u);
  assert.match(first.stagedProcessError, /before activation commits/u);

  const persisted = await first.api.config.replace(
    "workspace",
    { generation: 1 },
    { expectedRevision: first.stagedConfig.revision },
  );
  const echoId = first.start(echoScript, "pipe");
  assert.equal(typeof echoId, "string");
  assert.match(echoId, /^process_[a-f0-9]+$/u);
  assert.equal(first.api.processes.status(echoId).id, echoId);
  await assert.rejects(
    first.api.processes.write(echoId, "x".repeat(64 * 1024 + 1)),
    /exceeds 65536 bytes/u,
  );
  await first.api.processes.write(echoId, "abcdef");
  await first.api.processes.closeInput(echoId);
  assert.equal((await readPipe(first.api, echoId, 2)).toString("utf8"), "ABCDEF");
  assert.equal((await first.api.processes.wait(echoId)).state, "succeeded");

  const cancelledId = first.start(longScript);
  const cancelledPid = await readPid(first.api, cancelledId);
  assert.equal((await first.api.processes.cancel(cancelledId)).state, "cancelled");
  assert.equal((await first.api.processes.cancel(cancelledId)).state, "cancelled");
  await waitUntilGone(cancelledPid);

  const refreshId = first.start(longScript);
  const refreshPid = await readPid(first.api, refreshId);
  await writeFile(sourcePath, extensionSource(key, 2));
  await loader.refresh();
  await waitUntilGone(refreshPid);
  assert.throws(() => first.api.processes.status(refreshId), /closed|no longer active/u);
  await assert.rejects(first.api.config.read("workspace"), /closed|no longer active|aborted/u);

  const second = probes(key)[1]!;
  assert.deepEqual(second.stagedConfig, persisted);
  assert.deepEqual(await second.api.config.read("workspace"), persisted);
  assert.match(second.stagedConfigError, /not writable/u);
  assert.match(second.stagedProcessError, /before activation commits/u);

  await writeFile(sourcePath, extensionSource(key, 3));
  await assert.rejects(
    loader.refresh({ prepareExtensions() { throw new Error("candidate rejected"); } }),
    /candidate rejected/u,
  );
  const rejected = probes(key)[2]!;
  assert.deepEqual(rejected.stagedConfig, persisted);
  assert.match(rejected.stagedConfigError, /not writable/u);
  assert.match(rejected.stagedProcessError, /before activation commits/u);
  await assert.rejects(rejected.api.config.read("workspace"), /closed|no longer active|aborted/u);
  assert.deepEqual(await second.api.config.read("workspace"), persisted);
});
