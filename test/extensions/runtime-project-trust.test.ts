import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  appendRuntimeExtensions,
  loadRuntimeExtensions,
  type RuntimeProjectTrustUi,
} from "../../src/extensions/runtime.js";
import { sha256 } from "../../src/tools/hash.js";

async function sourceEntry(root: string, id: string, source: string) {
  const path = join(root, `${id}.mjs`);
  await writeFile(path, source);
  return { extensionId: id, sourcePath: path, sha256: sha256(source), scope: "user" as const, trusted: true };
}

test("project trust is limited, diagnostic on errors, and first decision wins", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-project-trust-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const projectOnly = {
    ...await sourceEntry(root, "project-only", `export default (api) => api.on("project_trust", () => {
      globalThis.__rigynProjectTrustListener = true;
      return { decision: "no" };
    });\n`),
    scope: "project" as const,
  };
  const entries = [
    await sourceEntry(root, "broken", `export default (api) => api.on("project_trust", () => { throw new Error("trust probe failed"); });\n`),
    await sourceEntry(root, "invalid", `export default (api) => api.on("project_trust", () => ({ decision: "maybe" }));\n`),
    await sourceEntry(root, "advisory", `export default (api) => api.on("project_trust", (event, context) => {
      globalThis.__rigynTrustObserved = { event, contextKeys: Object.keys(context.ui).sort() };
      return { decision: "undecided" };
    });\n`),
    projectOnly,
    await sourceEntry(root, "decider", `export default (api) => api.on("project_trust", async (_event, context) => ({
      decision: await context.ui.confirm("Trust", "Enable resources") ? "yes" : "no",
      remember: true,
    }));\n`),
    await sourceEntry(root, "late", `export default (api) => api.on("project_trust", () => {
      globalThis.__rigynLateTrustListener = true;
      return { decision: "no" };
    });\n`),
  ];
  const host = await loadRuntimeExtensions(entries, { workspace: root });
  const confirmations: string[] = [];
  const ui: RuntimeProjectTrustUi = {
    hasUI: true,
    async confirm(title, message) {
      confirmations.push(`${title}:${message}`);
      return true;
    },
  };

  assert.deepEqual(await host.resolveProjectTrust({ workspace: root, cwd: resolve(root, "..") }, ui), {
    decision: "yes",
    remember: true,
  });
  assert.deepEqual(confirmations, ["Trust:Enable resources"]);
  assert.deepEqual((globalThis as Record<string, unknown>).__rigynTrustObserved, {
    event: { workspace: resolve(root), cwd: resolve(root, "..") },
    contextKeys: ["confirm", "hasUI"],
  });
  assert.equal((globalThis as Record<string, unknown>).__rigynLateTrustListener, undefined);
  assert.equal((globalThis as Record<string, unknown>).__rigynProjectTrustListener, undefined);
  assert.match(host.diagnostics()[0]?.message ?? "", /trust probe failed/u);
  assert.match(host.diagnostics()[1]?.message ?? "", /decision must be yes, no, or undecided/u);
  await host.close();
  delete (globalThis as Record<string, unknown>).__rigynTrustObserved;
  delete (globalThis as Record<string, unknown>).__rigynLateTrustListener;
  delete (globalThis as Record<string, unknown>).__rigynProjectTrustListener;
});

test("headless project trust is available without exposing interactive controls", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-project-trust-headless-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const entry = await sourceEntry(root, "headless", `export default (api) => api.on("project_trust", async (_event, context) => {
    try { await context.ui.confirm("Trust", "Unavailable"); }
    catch { return { decision: context.ui.hasUI ? "yes" : "no" }; }
    return { decision: "yes" };
  });\n`);
  const host = await loadRuntimeExtensions([entry], { workspace: root });
  assert.deepEqual(await host.resolveProjectTrust({ workspace: root, cwd: root }), { decision: "no" });
  await host.close();
});

test("incremental activation preserves the active generation and does not reactivate prior entries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-project-trust-append-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "project"));
  const user = await sourceEntry(root, "user", `export default (api) => {
    globalThis.__rigynUserActivationCount = (globalThis.__rigynUserActivationCount ?? 0) + 1;
    api.registerCommand({ name: "user-command", execute() {} });
  };\n`);
  const project = await sourceEntry(join(root, "project"), "project", `export default (api) => {
    api.registerCommand({ name: "project-command", execute() {} });
  };\n`);
  const host = await loadRuntimeExtensions([user], { workspace: root });
  await appendRuntimeExtensions(host, [project], { workspace: root });

  assert.equal((globalThis as Record<string, unknown>).__rigynUserActivationCount, 1);
  assert.deepEqual(host.commands().map((entry) => entry.name), ["user-command", "project-command"]);
  await assert.rejects(appendRuntimeExtensions(host, [user], { workspace: root }), /already active/u);
  await host.close();
  delete (globalThis as Record<string, unknown>).__rigynUserActivationCount;
});
