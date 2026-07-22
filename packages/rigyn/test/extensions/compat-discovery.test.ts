import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { createEventBus } from "../../src/core/event-bus.js";
import {
  discoverAndLoadExtensions,
  getExtensionRuntimeHost,
  projectLoadedExtensionHost,
} from "../../src/extensions/compat.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";

const roots = new Set<string>();

async function temporaryDirectory(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.add(root);
  return root;
}

async function moduleFile(path: string, body = "export default () => {};\n"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
}

test.afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__compatLoaderCount;
  delete (globalThis as Record<string, unknown>).__compatLoaderApi;
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test("discovers project, user, and explicit factories with manifest and index precedence", async () => {
  const cwd = await temporaryDirectory("rigyn-compat-discovery-");
  const agentDir = await temporaryDirectory("rigyn-compat-agent-");
  const projectExtensions = join(cwd, ".rigyn", "extensions");
  const packageDirectory = join(projectExtensions, "manifest-package");
  const direct = join(projectExtensions, "direct.ts");
  const declared = join(packageDirectory, "declared.js");
  const ignoredPackageIndex = join(packageDirectory, "index.ts");
  const ignoredNested = join(projectExtensions, "nested", "deeper", "index.ts");
  const ignoredModule = join(projectExtensions, "ignored.mjs");
  const user = join(agentDir, "extensions", "user.js");
  const explicitDirectory = join(cwd, "explicit");
  const explicitIndex = join(explicitDirectory, "index.ts");
  const ignoredExplicitSibling = join(explicitDirectory, "sibling.ts");

  await moduleFile(direct);
  await moduleFile(declared);
  await moduleFile(ignoredPackageIndex);
  await moduleFile(ignoredNested);
  await moduleFile(ignoredModule);
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ rigyn: { extensions: ["declared.js"] } }),
    "utf8",
  );
  await moduleFile(user);
  await moduleFile(explicitIndex);
  await moduleFile(ignoredExplicitSibling);

  const result = await discoverAndLoadExtensions([explicitDirectory], cwd, agentDir);
  try {
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 4);
    assert.deepEqual(
      new Set(result.extensions.slice(0, 2).map((extension) => basename(extension.resolvedPath))),
      new Set(["direct.ts", "declared.js"]),
    );
    assert.equal(basename(result.extensions[2]!.resolvedPath), "user.js");
    assert.equal(basename(result.extensions[3]!.resolvedPath), "index.ts");
    assert.equal(result.extensions.some((extension) => extension.resolvedPath === ignoredPackageIndex), false);
    assert.equal(result.extensions.some((extension) => extension.resolvedPath === ignoredNested), false);
    assert.equal(result.extensions.some((extension) => extension.resolvedPath === ignoredModule), false);
    assert.equal(result.extensions.some((extension) => extension.resolvedPath === ignoredExplicitSibling), false);
    assert.deepEqual(result.extensions.map((extension) => extension.sourceInfo.scope).sort(), [
      "project",
      "project",
      "temporary",
      "user",
    ]);
  } finally {
    await getExtensionRuntimeHost(result.runtime)?.close();
  }
});

test("deduplicates canonically with the first discovery source retaining ownership", async () => {
  const cwd = await temporaryDirectory("rigyn-compat-dedup-");
  const agentDir = await temporaryDirectory("rigyn-compat-agent-");
  const direct = join(cwd, ".rigyn", "extensions", "same.ts");
  await moduleFile(direct);

  const result = await discoverAndLoadExtensions([
    direct,
    join(cwd, ".rigyn", "extensions", ".", "same.ts"),
  ], cwd, agentDir);
  try {
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0]!.sourceInfo.scope, "project");
  } finally {
    await getExtensionRuntimeHost(result.runtime)?.close();
  }
});

test("records one path failure and continues loading later factories", async () => {
  const cwd = await temporaryDirectory("rigyn-compat-errors-");
  const agentDir = await temporaryDirectory("rigyn-compat-agent-");
  const invalid = join(cwd, "invalid.ts");
  const valid = join(cwd, "valid.ts");
  await moduleFile(invalid, "export default { invalid: true };\n");
  await moduleFile(valid, "export default (api) => api.registerFlag('loaded', { type: 'boolean', default: true });\n");

  const result = await discoverAndLoadExtensions([invalid, valid], cwd, agentDir);
  try {
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.path, invalid);
    assert.match(result.errors[0]!.error, /^Failed to load extension:/u);
    assert.deepEqual(result.extensions.map((extension) => extension.path), [valid]);
    assert.equal(result.extensions[0]!.flags.has("loaded"), true);
    assert.equal(result.runtime.flagValues.get("loaded"), true);
  } finally {
    await getExtensionRuntimeHost(result.runtime)?.close();
  }
});

test("projects exact direct registrations while retaining one native execution authority", async () => {
  const cwd = await temporaryDirectory("rigyn-compat-projection-");
  const agentDir = await temporaryDirectory("rigyn-compat-agent-");
  const source = join(cwd, "complete.ts");
  await moduleFile(source, `
export default (api) => {
  globalThis.__compatLoaderApi = api;
  api.on("session_start", () => {});
  api.registerTool({
    name: "inspect",
    label: "Inspect",
    description: "Inspect a value",
    parameters: { type: "object" },
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
  });
  api.registerCommand("review", { description: "Review", async handler() {} });
  api.registerFlag("verbose", { description: "Verbose", type: "boolean", default: false });
  api.registerShortcut("ctrl+g", { description: "Go", handler() {} });
  api.registerMessageRenderer("notice", () => undefined);
  api.registerEntryRenderer("state", () => undefined);
};
`);

  const result = await discoverAndLoadExtensions([source], cwd, agentDir);
  try {
    const extension = result.extensions[0]!;
    assert.ok(getExtensionRuntimeHost(result.runtime));
    assert.deepEqual([...extension.handlers.keys()], ["session_start"]);
    assert.deepEqual([...extension.tools.keys()], ["inspect"]);
    assert.deepEqual([...extension.commands.keys()], ["review"]);
    assert.deepEqual([...extension.flags.keys()], ["verbose"]);
    assert.deepEqual([...extension.shortcuts.keys()], ["ctrl+g"]);
    assert.deepEqual([...extension.messageRenderers.keys()], ["notice"]);
    assert.deepEqual([...extension.entryRenderers!.keys()], ["state"]);

    const api = (globalThis as Record<string, unknown>).__compatLoaderApi as {
      registerCommand(name: string, command: { handler(): Promise<void> }): void;
    };
    api.registerCommand("late", { async handler() {} });
    assert.equal(extension.commands.has("late"), true);
  } finally {
    await getExtensionRuntimeHost(result.runtime)?.close();
  }
});

test("uses a supplied event bus and removes generation listeners on shutdown", async () => {
  const cwd = await temporaryDirectory("rigyn-compat-events-");
  const agentDir = await temporaryDirectory("rigyn-compat-agent-");
  const listener = join(cwd, "listener.ts");
  const emitter = join(cwd, "emitter.ts");
  await moduleFile(listener, `
export default (api) => api.events.on("compat:ping", () => {
  globalThis.__compatLoaderCount = (globalThis.__compatLoaderCount ?? 0) + 1;
});
`);
  await moduleFile(emitter, "export default (api) => api.events.emit('compat:ping', { ok: true });\n");
  const eventBus = createEventBus();

  const result = await discoverAndLoadExtensions([listener, emitter], cwd, agentDir, eventBus);
  assert.equal((globalThis as Record<string, unknown>).__compatLoaderCount, 1);
  const host = getExtensionRuntimeHost(result.runtime);
  assert.ok(host);
  await host.close();
  eventBus.emit("compat:ping", { ok: true });
  assert.equal((globalThis as Record<string, unknown>).__compatLoaderCount, 1);
});

test("rolls back supplied event-bus listeners when activation fails", async () => {
  const cwd = await temporaryDirectory("rigyn-compat-event-rollback-");
  const agentDir = await temporaryDirectory("rigyn-compat-agent-");
  const source = join(cwd, "failure.ts");
  await moduleFile(source, `
export default (api) => {
  api.events.on("compat:rollback", () => {
    globalThis.__compatLoaderCount = (globalThis.__compatLoaderCount ?? 0) + 1;
  });
  throw new Error("activation failed");
};
`);
  const eventBus = createEventBus();

  const result = await discoverAndLoadExtensions([source], cwd, agentDir, eventBus);
  try {
    assert.equal(result.extensions.length, 0);
    assert.equal(result.errors.length, 1);
    eventBus.emit("compat:rollback", null);
    assert.equal((globalThis as Record<string, unknown>).__compatLoaderCount, undefined);
  } finally {
    await getExtensionRuntimeHost(result.runtime)?.close();
  }
});

test("projects an existing host without evaluating its factories again", async () => {
  const cwd = await temporaryDirectory("rigyn-compat-existing-host-");
  const source = join(cwd, "existing.ts");
  await moduleFile(source, `
export default (api) => {
  globalThis.__compatLoaderCount = (globalThis.__compatLoaderCount ?? 0) + 1;
  api.registerCommand("existing", { async handler() {} });
};
`);
  const host = await loadDirectExtensions([source], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "hidden-inline",
      hidden: true,
      factory(api) {
        api.registerFlag("inline", { type: "boolean", default: true });
      },
    }],
  });

  const result = projectLoadedExtensionHost(host);
  try {
    assert.equal((globalThis as Record<string, unknown>).__compatLoaderCount, 1);
    assert.equal(result.extensions.length, 2);
    assert.equal(result.extensions[0]!.commands.has("existing"), true);
    assert.equal(result.extensions[1]!.hidden, true);
    assert.equal(result.extensions[1]!.flags.has("inline"), true);
    assert.equal(getExtensionRuntimeHost(result.runtime), host);
  } finally {
    await host.close();
  }
});
