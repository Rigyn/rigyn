import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getExtensionRuntimeHost } from "../../src/extensions/compat.js";
import type { ExtensionAPI } from "../../src/extensions/direct.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";

async function temporaryWorkspace(context: test.TestContext, prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  return workspace;
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise<void>((resolveValue) => setTimeout(resolveValue, 20));
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || code === "EINVAL") return;
      throw cause;
    }
  }
  assert.fail(`managed child ${pid} survived runtime close`);
}

test("public-only TypeScript extensions can start and await generation-owned processes", async (context) => {
  const workspace = await temporaryWorkspace(context, "rigyn-managed-process-extension-");
  const sourcePath = join(workspace, "extension.ts");
  await writeFile(sourcePath, `
    import type { ExtensionAPI } from "rigyn/extensions";
    export default function (rigyn: ExtensionAPI) {
      globalThis.__rigynManagedProcessApi = rigyn;
    }
  `);
  const host = await loadDirectExtensions([sourcePath], {
    workspace,
    activationFailure: "throw",
  });
  context.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__rigynManagedProcessApi;
  });
  const api = (globalThis as Record<string, unknown>).__rigynManagedProcessApi as ExtensionAPI;

  const id = api.processes.spawn({
    argv: [process.execPath, "--eval", "process.stdout.write('public process')"],
  });
  const result = await api.processes.wait(id);

  assert.equal(result.state, "succeeded");
  assert.equal(Buffer.from(result.stdout).toString("utf8"), "public process");
  assert.equal("pid" in result, false);
  if (process.platform !== "win32") assert.deepEqual(host.diagnostics(), []);
});

test("runtime close kills active managed children and makes the old service stale", async (context) => {
  const workspace = await temporaryWorkspace(context, "rigyn-managed-process-close-");
  let api: ExtensionAPI | undefined;
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [(value) => { api = value; }],
  });
  assert.ok(api !== undefined);

  const id = api.processes.spawn({
    argv: [
      process.execPath,
      "--eval",
      "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  const page = await api.processes.read(id, "stdout", { maxBytes: 64 });
  const pid = Number(Buffer.from(page.data).toString("utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);

  await host.close();
  await waitUntilGone(pid);
  assert.throws(() => api!.processes.status(id), /closed|no longer active/u);
});

test("managed processes cannot escape a failed precommit activation", async (context) => {
  const workspace = await temporaryWorkspace(context, "rigyn-managed-process-precommit-");
  await assert.rejects(
    loadDirectExtensions([], {
      workspace,
      activationFailure: "throw",
      inlineExtensions: [(api) => {
        api.processes.spawn({ argv: [process.execPath, "--eval", "setInterval(() => {}, 1000)"] });
      }],
    }),
    /before activation commits/u,
  );
});

test("transactional resource refresh reaps the previous generation's managed processes", async (context) => {
  const root = await temporaryWorkspace(context, "rigyn-managed-process-refresh-");
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const generations: ExtensionAPI[] = [];
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [{
      name: "managed-process-refresh",
      factory(api) { generations.push(api); },
    }],
  });
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());

  await loader.refresh();
  const previous = generations[0];
  assert.ok(previous !== undefined);
  const id = previous.processes.spawn({
    argv: [
      process.execPath,
      "--eval",
      "process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  const page = await previous.processes.read(id, "stdout", { maxBytes: 64 });
  const pid = Number(Buffer.from(page.data).toString("utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);

  await loader.refresh();
  await waitUntilGone(pid);
  assert.equal(generations.length, 2);
  assert.notEqual(generations[1], previous);
  assert.throws(() => previous.processes.status(id), /closed|no longer active/u);
});
