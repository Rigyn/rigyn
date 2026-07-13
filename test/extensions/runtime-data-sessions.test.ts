import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";
import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { decodeHarnessSessionCursor, parseHarnessSessionPage } from "../../src/service/session-catalog.js";
import { SessionStore } from "../../src/storage/store.js";
import { sha256 } from "../../src/tools/hash.js";

test("installed runtime data paths are stable, private, outside package contents, and safe resource roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-data-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const outsideSkill = join(root, "outside-skill");
  await mkdir(workspace, { recursive: true });
  await mkdir(outsideSkill);
  await writeFile(join(outsideSkill, "SKILL.md"), "---\nname: rejected-outside\ndescription: Must not load.\n---\nNo.\n");
  const extensionPath = join(workspace, "data-extension.mjs");
  const source = `
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default async function activate(api) {
  const skill = join(api.dataPaths.workspace, "skills", "generated");
  await mkdir(skill, { recursive: true });
  await writeFile(join(api.dataPaths.user, "stable.txt"), "durable");
  await writeFile(join(skill, "SKILL.md"), "---\\nname: generated-owned\\ndescription: Owned data resource.\\n---\\nUse it.\\n");
  const linked = join(api.dataPaths.workspace, "linked-skill");
  await symlink(${JSON.stringify(outsideSkill)}, linked).catch((error) => { if (error?.code !== "EEXIST") throw error; });
  globalThis.__runtimeDataPaths = api.dataPaths;
  api.on("resources_discover", () => ({
    skillPaths: [join(skill, "SKILL.md"), ${JSON.stringify(join(outsideSkill, "SKILL.md"))}, linked],
  }));
}
`;
  await writeFile(extensionPath, source);
  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    state: process.env.XDG_STATE_HOME,
    key: process.env.RIGYN_CREDENTIAL_KEY,
  };
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.RIGYN_CREDENTIAL_KEY = Buffer.alloc(32, 19).toString("base64url");
  t.after(async () => {
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous.state;
    if (previous.key === undefined) delete process.env.RIGYN_CREDENTIAL_KEY;
    else process.env.RIGYN_CREDENTIAL_KEY = previous.key;
    delete (globalThis as Record<string, unknown>).__runtimeDataPaths;
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await loadRuntime({
    workspace,
    ephemeral: true,
    extensions: false,
    extensionRuntime: true,
    extensionPaths: [extensionPath],
    skills: true,
  });
  t.after(async () => await runtime.close());
  const paths = (globalThis as Record<string, unknown>).__runtimeDataPaths as { user: string; workspace: string };
  const productionRoot = join(stateHome, "rigyn", "extension-data");
  assert.equal(runtime.runtimeExtensions.dataRoot, productionRoot);
  assert.equal(relative(productionRoot, paths.user).startsWith(".."), false);
  assert.equal(relative(productionRoot, paths.workspace).startsWith(".."), false);
  assert.equal(relative(dirname(extensionPath), paths.user).startsWith(".."), true);
  assert.notEqual(paths.user, paths.workspace);
  if (process.platform !== "win32") {
    assert.equal((await lstat(paths.user)).mode & 0o777, 0o700);
    assert.equal((await lstat(paths.workspace)).mode & 0o777, 0o700);
  }
  assert.equal(await readFile(join(paths.user, "stable.txt"), "utf8"), "durable");
  assert.equal(runtime.service.skills.some((skill) => skill.name === "generated-owned"), true);
  assert.equal(runtime.service.skills.some((skill) => skill.name === "rejected-outside"), false);
  const ignored = runtime.runtimeExtensions.diagnostics().filter((entry) => entry.message.includes("Runtime resource path was ignored"));
  assert.equal(ignored.length, 2);

  const first = { ...paths };
  await runtime.close();
  const reopened = await loadRuntime({
    workspace,
    ephemeral: true,
    extensions: false,
    extensionRuntime: true,
    extensionPaths: [extensionPath],
  });
  try {
    assert.deepEqual((globalThis as Record<string, unknown>).__runtimeDataPaths, first);
  } finally {
    await reopened.close();
  }
});

test("runtime session discovery is bounded, paginated, searchable, and workspace isolated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-session-list-"));
  const outsideWorkspace = join(root, "outside-workspace");
  await mkdir(outsideWorkspace);
  const sourcePath = join(root, "sessions.mjs");
  const source = "export default (api) => { globalThis.__runtimeSessionListApi = api; };\n";
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "session-list",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root, dataRoot: join(root, "state", "extension-data") });
  assert.equal(host.dataRoot, join(root, "state", "extension-data"));
  let tick = 0;
  const store = new SessionStore(join(root, "sessions.sqlite"), {
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry(),
    runtimeExtensions: host,
  });
  await service.initialize({ skills: [] });
  t.after(async () => {
    await service.close("runtime_session_list_test");
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__runtimeSessionListApi;
    await rm(root, { recursive: true, force: true });
  });
  for (const [threadId, name] of [
    ["thread-a", "Alpha one"],
    ["thread-b", "Beta"],
    ["thread-c", "Alpha two"],
    ["thread-d", "Delta"],
    ["thread-e", "Echo"],
  ] as const) store.createThread({ threadId, name, workspaceRoot: root });
  store.createThread({ threadId: "thread-outside", name: "Alpha outside", workspaceRoot: outsideWorkspace });
  store.appendEvent({
    threadId: "thread-b",
    event: {
      type: "message_appended",
      message: {
        id: "hidden-search-message",
        role: "user",
        content: [{ type: "text", text: "content-only-marker" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
  });
  const api = (globalThis as Record<string, any>).__runtimeSessionListApi;

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listSessions({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(page.sessions.length <= 2, true);
    for (const session of page.sessions) {
      assert.deepEqual(Object.keys(session).sort(), ["createdAt", "defaultBranch", "name", "threadId", "updatedAt"]);
      seen.push(session.threadId);
    }
    cursor = page.nextCursor;
    assert.equal(page.hasMore, cursor !== undefined);
  } while (cursor !== undefined);
  assert.equal(new Set(seen).size, 5);
  assert.equal(seen.includes("thread-outside"), false);

  const alpha = await api.listSessions({ search: "alpha", limit: 10 });
  assert.deepEqual(alpha.sessions.map((session: { threadId: string }) => session.threadId).sort(), ["thread-a", "thread-c"]);
  const alphaFirst = await api.listSessions({ search: "alpha", limit: 1 });
  assert.ok(alphaFirst.nextCursor);
  await assert.rejects(
    api.listSessions({ search: "beta", limit: 1, cursor: alphaFirst.nextCursor }),
    /cursor is invalid/u,
  );
  assert.throws(
    () => decodeHarnessSessionCursor(alphaFirst.nextCursor, outsideWorkspace, "alpha"),
    /cursor is invalid/u,
  );
  assert.deepEqual((await api.listSessions({ search: "content-only-marker" })).sessions, []);
  await assert.rejects(api.listSessions({ cursor: "not+a+cursor" }), /cursor is invalid/u);
  await assert.rejects(api.listSessions({ limit: 101 }), /limit must be from 1 through 100/u);
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancel session discovery"));
  await assert.rejects(api.listSessions({ signal: cancelled.signal }), /cancel session discovery/u);

  const selected = alpha.sessions[0];
  assert.ok(selected);
  const transcript = await api.getTranscript({ threadId: selected.threadId, branch: selected.defaultBranch });
  assert.equal(transcript.threadId, selected.threadId);
  await assert.rejects(api.getTranscript({ threadId: "thread-outside" }), /belongs to/u);
});

test("session metadata pages reject accessor-backed or oversized boundary values", () => {
  const session: Record<string, unknown> = {
    name: "unsafe",
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  Object.defineProperty(session, "threadId", {
    enumerable: true,
    get() { throw new Error("getter must not run"); },
  });
  assert.throws(() => parseHarnessSessionPage({
    schemaVersion: 1,
    sessions: [session],
    hasMore: false,
  }), /enumerable data fields/u);
  assert.throws(() => parseHarnessSessionPage({
    schemaVersion: 1,
    sessions: Array.from({ length: 101 }, (_, index) => ({
      threadId: `thread-${index}`,
      defaultBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    hasMore: false,
  }), /sessions are invalid/u);
});
