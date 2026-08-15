import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSessionV4Bytes } from "@rigyn/kernel/session-v4";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { CanonicalMessage, NormalizedUsage } from "../../src/core/types.js";
import { SESSION_EXPORT_CLIENT } from "../../src/storage/session-export-client.js";
import {
  sessionExportBoundedJson,
  sessionExportBoundedText,
  sessionExportBranchChildDepth,
  sessionExportMutationPreview,
  sessionExportMutationResultPreview,
  sessionExportSearchText,
  sessionExportToolCallSummary,
  sessionExportToolResultSummary,
  sessionExportTreeRows,
} from "../../src/storage/session-export-presentation.js";
import {
  buildSessionExportData,
  exportSessionFile,
  renderSessionHtml,
  resolveSessionExportTheme,
  serializeSessionRecords,
  sessionExportUsage,
} from "../../src/storage/session-export.js";
import { MAX_SESSION_FILE_BYTES, SessionManager } from "../../src/storage/session-manager.js";
import type { SessionExportData } from "../../src/storage/session-export.js";
import type { RuntimeToolRendererBinding } from "../../src/tui/components.js";

const roots = new Set<string>();

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function message(role: "system" | "user" | "assistant" | "tool", content: CanonicalMessage["content"], id: string): CanonicalMessage {
  return { id, role, content, createdAt: "2026-01-01T00:00:00.000Z" };
}

function usage(seed: number): NormalizedUsage {
  return {
    inputTokens: seed,
    outputTokens: seed + 1,
    cacheReadTokens: seed + 2,
    cacheWriteTokens: seed + 3,
    totalTokens: seed * 4 + 6,
    reasoningTokens: seed + 4,
    cost: {
      input: seed / 100,
      output: (seed + 1) / 100,
      cacheRead: (seed + 2) / 100,
      cacheWrite: (seed + 3) / 100,
      total: (seed * 4 + 6) / 100,
    },
  };
}

function embeddedData(document: string): SessionExportData {
  const match = document.match(/<script id="session-data" type="application\/octet-stream">([A-Za-z0-9+/=]+)<\/script>/u);
  assert.ok(match?.[1]);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as SessionExportData;
}

test("session export presentation uses branch-only indentation with a defensive cap", () => {
  let depth = 0;
  for (let index = 0; index < 400; index += 1) {
    depth = sessionExportBranchChildDepth(depth, 1);
  }
  assert.equal(depth, 0);
  depth = sessionExportBranchChildDepth(depth, 2);
  assert.equal(depth, 1);
  depth = sessionExportBranchChildDepth(depth, 1);
  assert.equal(depth, 1);
  for (let index = 0; index < 100; index += 1) {
    depth = sessionExportBranchChildDepth(depth, 2);
  }
  assert.equal(depth, 24);

  type Node = { id: string; children: Node[] };
  const linear = Array.from({ length: 400 }, (_, index): Node => ({ id: `linear-${index}`, children: [] }));
  for (let index = 0; index < linear.length - 1; index += 1) linear[index]!.children.push(linear[index + 1]!);
  assert.equal(Math.max(...sessionExportTreeRows([linear[0]!], linear).map((row) => row.depth)), 0);

  const root: Node = { id: "root", children: [] };
  const left: Node = { id: "left", children: [] };
  const right: Node = { id: "right", children: [] };
  const rightNext: Node = { id: "right-next", children: [] };
  root.children.push(left, right, left);
  right.children.push(rightNext);
  rightNext.children.push(root);
  assert.deepEqual(sessionExportTreeRows([root], [root, left, right, rightNext]).map(({ node, depth: rowDepth, connector }) => ({
    id: node.id,
    depth: rowDepth,
    connector,
  })), [
    { id: "root", depth: 0, connector: "" },
    { id: "left", depth: 1, connector: "├─ " },
    { id: "right", depth: 1, connector: "└─ " },
    { id: "right-next", depth: 1, connector: "" },
  ]);
});

test("session export tool presentation keeps file mutations semantic and multiline", () => {
  const write = { path: "src/file.ts", content: "one\n世界\n" };
  assert.equal(
    sessionExportToolCallSummary("write", write),
    "tool call · write · src/file.ts · 2 lines · 11 bytes",
  );
  assert.equal(sessionExportMutationPreview("write", write), "one\n世界\n");

  const edit = {
    path: "src/file.ts",
    edits: [
      { oldText: "a\nb", newText: "x\ny\nz" },
      { oldText: "old", newText: "new" },
    ],
  };
  assert.equal(
    sessionExportToolCallSummary("edit", edit),
    "tool call · edit · src/file.ts · 2 edits · 3 → 4 lines · 6 → 8 bytes",
  );
  const preview = sessionExportMutationPreview("edit", edit);
  assert.equal(
    preview,
    "--- edit 1 before\na\nb\n+++ edit 1 after\nx\ny\nz\n--- edit 2 before\nold\n+++ edit 2 after\nnew",
  );
  assert.equal(preview?.includes("\\n"), false);
  assert.equal(
    sessionExportMutationResultPreview("edit", false, { diff: "-before\n+after" }),
    "-before\n+after",
  );
  assert.equal(sessionExportMutationResultPreview("edit", true, { diff: "ignored" }), undefined);
});

test("session export tool summaries are concise and bounded previews retain honest totals", () => {
  assert.equal(
    sessionExportToolCallSummary("read", { path: "README.md", offset: 5, limit: 10 }),
    "tool call · read · README.md:5-14",
  );
  assert.equal(
    sessionExportToolCallSummary("grep", { pattern: "needle", path: "src", limit: 20 }),
    "tool call · grep · /needle/ · in src · limit 20",
  );
  assert.equal(
    sessionExportToolCallSummary("bash", { command: "npm test\nignored", timeout: 30 }),
    "tool call · bash · $ npm test ignored · timeout 30s",
  );
  assert.equal(
    sessionExportToolCallSummary("extension.tool", { payload: "private" }),
    "tool call · extension.tool",
  );
  assert.equal(
    sessionExportToolResultSummary("write", false, "wrote\nfile"),
    "tool result · write · success · 2 lines · 10 bytes",
  );

  const source = `${"x".repeat(500)}\n${Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n")}`;
  const bounded = sessionExportBoundedText(source, 1_024, 20, 80);
  assert.equal(bounded.totalBytes, Buffer.byteLength(source, "utf8"));
  assert.equal(bounded.totalLines, 101);
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 1_024);
  assert.match(bounded.text, /bytes omitted from line/u);
  assert.match(bounded.text, /lines omitted/u);
  assert.doesNotMatch(bounded.text, /\ufffd/u);

  const boundedJson = sessionExportBoundedJson({
    payload: "x".repeat(100_000),
    nested: { one: { two: { three: { four: "kept" } } } },
  }, 1_024, 16, 3, 256);
  assert.ok(Buffer.byteLength(boundedJson, "utf8") <= 1_024);
  assert.match(boundedJson, /preview bytes omitted|depth limit/u);

  const searchText = sessionExportSearchText(["PREFIX", "🚀".repeat(1024 * 1024)], 1_024);
  assert.ok(Buffer.byteLength(searchText, "utf8") <= 1_024);
  assert.match(searchText, /^prefix /u);
  assert.doesNotMatch(searchText, /\ufffd/u);
});

test("session export bounded JSON charges primitive array items and object properties", () => {
  let arrayReads = 0;
  const array = new Proxy(Array.from({ length: 10_000 }, (_, index) => index), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/u.test(key)) arrayReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const arrayJson = sessionExportBoundedJson(array, 1_024, 16);
  assert.ok(arrayReads <= 16, `expected at most 16 primitive reads, received ${arrayReads}`);
  assert.match(arrayJson, /remaining values omitted/u);

  let propertyReads = 0;
  const record = new Proxy(Object.fromEntries(
    Array.from({ length: 10_000 }, (_, index) => [`key-${index}`, index]),
  ), {
    get(target, key, receiver) {
      if (typeof key === "string" && key.startsWith("key-")) propertyReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const objectJson = sessionExportBoundedJson(record, 1_024, 16);
  assert.ok(propertyReads <= 16, `expected at most 16 primitive reads, received ${propertyReads}`);
  assert.match(objectJson, /properties omitted/u);

  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.match(sessionExportBoundedJson(circular), /circular value omitted/u);
});

test("session export bounds maximum-size Unicode and newline-dense previews", () => {
  const maximumBytes = 16 * 1024 * 1024;
  {
    const source = "🚀".repeat(maximumBytes / 4);
    const bounded = sessionExportBoundedText(source);
    assert.equal(bounded.totalBytes, maximumBytes);
    assert.equal(bounded.totalLines, 1);
    assert.equal(bounded.truncated, true);
    assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 64 * 1024);
    assert.doesNotMatch(bounded.text, /\ufffd/u);
  }
  {
    const source = "x\n".repeat(maximumBytes / 2);
    const bounded = sessionExportBoundedText(source);
    assert.equal(bounded.totalBytes, maximumBytes);
    assert.equal(bounded.totalLines, maximumBytes / 2);
    assert.equal(bounded.truncated, true);
    assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 64 * 1024);
    assert.match(bounded.text, /lines omitted/u);
    assert.doesNotMatch(bounded.text, /\ufffd/u);
  }
});

test("standalone export client wires the bounded lazy presentation helpers", () => {
  assert.match(SESSION_EXPORT_CLIENT, /sessionExportBranchChildDepth/u);
  assert.match(SESSION_EXPORT_CLIENT, /sessionExportToolCallSummary/u);
  assert.match(SESSION_EXPORT_CLIENT, /sessionExportMutationPreview/u);
  assert.match(SESSION_EXPORT_CLIENT, /sessionExportBoundedText/u);
  assert.match(SESSION_EXPORT_CLIENT, /sessionExportSearchText/u);
  assert.doesNotMatch(SESSION_EXPORT_CLIENT, /block\.type === "text"\) return text\(block\.text\)/u);
  assert.match(SESSION_EXPORT_CLIENT, /function appendMarkdownPreview/u);
  assert.match(SESSION_EXPORT_CLIENT, /function lazyDetails/u);
  assert.match(SESSION_EXPORT_CLIENT, /lazyDetails\("skill-card"/u);
  assert.match(SESSION_EXPORT_CLIENT, /block\.type === "thinking"/u);
  assert.match(SESSION_EXPORT_CLIENT, /entry\.type === "model_change"/u);
  assert.match(SESSION_EXPORT_CLIENT, /entry\.type === "thinking_level_change"/u);
});

async function managerFixture(name = "exportable"): Promise<{ root: string; manager: SessionManager }> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-export-"));
  roots.add(root);
  return { root, manager: SessionManager.create(root, join(root, "sessions"), { id: name }) };
}

test("standalone export embeds exact UTF-8 JSONL and needs no provider runtime", async () => {
  const { root, manager } = await managerFixture();
  manager.appendSessionInfo("Export 世界 🚀");
  manager.appendMessage(message("user", [{ type: "text", text: "Inspect <this> safely — café" }], "user-1"));
  manager.appendMessage(message("assistant", [{
    type: "tool_call",
    callId: "call-1",
    name: "read",
    arguments: { path: "README.md" },
  }], "assistant-1"));
  manager.appendMessage({
    ...message("tool", [{ type: "tool_result", callId: "call-1", name: "read", content: "  one\n\u001b[31mtwo\u001b[0m", isError: false }], "tool-1"),
  });
  manager.appendMessage(message("assistant", [{ type: "text", text: "Done" }], "assistant-2"));
  const output = join(root, "session.html");

  assert.equal(exportSessionFile(manager.getSessionFile()!, output), output);
  const document = await readFile(output, "utf8");
  const data = embeddedData(document);
  assert.equal(data.title, "Export 世界 🚀");
  assert.equal(data.jsonl, await readFile(manager.getSessionFile()!, "utf8"));
  assert.match(data.jsonl, /Inspect <this> safely — café/u);
  assert.match(document, /Content-Security-Policy/u);
  assert.match(document, /Download original JSONL/u);
  assert.match(document, /\.ansi-line/u);
  assert.match(document, /appendAnsiRows/u);
  if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test("standalone export refuses a symlink destination without changing its victim", async (context) => {
  if (process.platform === "win32") {
    context.skip("Creating file symlinks requires additional privileges on Windows");
    return;
  }
  const { root, manager } = await managerFixture("symlink-destination");
  manager.appendMessage(message("user", [{ type: "text", text: "keep the victim unchanged" }], "user"));
  const victim = join(root, "victim.txt");
  const output = join(root, "session.html");
  await writeFile(victim, "original victim", { encoding: "utf8", mode: 0o600 });
  await symlink(victim, output, "file");
  const entriesBefore = (await readdir(root)).sort();

  assert.throws(
    () => exportSessionFile(manager.getSessionFile()!, output),
    /export destination already exists/iu,
  );
  assert.equal(await readFile(victim, "utf8"), "original victim");
  assert.equal((await lstat(output)).isSymbolicLink(), true);
  assert.deepEqual((await readdir(root)).sort(), entriesBefore);
});

test("standalone export supports a long destination leaf without staging residue", async () => {
  const { root, manager } = await managerFixture("long-destination");
  manager.appendMessage(message("user", [{ type: "text", text: "long destination" }], "user"));
  const outputName = `${"x".repeat(220)}.html`;
  const output = join(root, outputName);
  const entriesBefore = await readdir(root);

  assert.equal(exportSessionFile(manager.getSessionFile()!, output), output);
  assert.deepEqual((await readdir(root)).sort(), [...entriesBefore, outputName].sort());
});

test("projected JSONL export is a strict settled V4 journal", async () => {
  const { manager } = await managerFixture("journal");
  const root = manager.appendMessage(message("user", [{ type: "text", text: "first" }], "user-1"));
  const leaf = manager.appendMessage(message("assistant", [{ type: "text", text: "done" }], "assistant-1"));
  manager.appendLabelChange(root, "start");
  manager.appendSessionInfo("Review");

  const entries = manager.getEntries();
  const jsonl = serializeSessionRecords(manager.getHeader(), entries, {
    leafId: manager.getLeafId(),
    name: "Review",
    labels: new Map([[root, manager.getLabel(root) as string]]),
  });
  const parsed = parseSessionV4Bytes(Buffer.from(jsonl, "utf8"));

  assert.equal(parsed.state.header.version, 4);
  assert.equal(parsed.state.header.sessionId, "journal");
  assert.equal(parsed.state.branches.get("main")?.headNodeId, leaf);
  assert.equal(parsed.state.nodes.size, 2);
  assert.equal(parsed.state.name, "Review");
  assert.equal(parsed.state.labels.get(root), "start");
  assert.equal(parsed.state.operations.size, 0);
  assert.equal(parsed.state.queue.size, 0);
  assert.equal(parsed.state.toolEffects.size, 0);
});

test("projected JSONL keeps native tool selection state", async () => {
  const { manager } = await managerFixture("tool-selection");
  const parentId = manager.appendMessage(message("user", [{ type: "text", text: "inspect" }], "user"));
  manager.commitChanges([{
    type: "conversation_node",
    node: {
      id: "tools",
      parentId,
      nodeType: "tools_change",
      tools: ["read", "grep"],
      toolsetFingerprint: "tools-fingerprint",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, {
    type: "head",
    branchId: "main",
    nodeId: "tools",
  }]);

  const parsed = parseSessionV4Bytes(Buffer.from(
    serializeSessionRecords(manager.getHeader(), manager.getEntries(), { leafId: manager.getLeafId() }),
    "utf8",
  ));
  assert.deepEqual(parsed.state.nodes.get("tools"), {
    id: "tools",
    parentId,
    nodeType: "tools_change",
    tools: ["read", "grep"],
    toolsetFingerprint: "tools-fingerprint",
    createdAt: "2026-01-01T00:00:01.000Z",
  });
});

test("redacted export removes secrets from every embedded and downloadable representation", async () => {
  const { root, manager } = await managerFixture("redacted");
  const secret = "sk-proj-abcdefghijklmnopqrstuvwx";
  manager.appendSessionInfo(`token ${secret}`);
  const labeledEntryId = manager.appendMessage(message("user", [{
    type: "text",
    text: `authorization: Bearer ${secret} api_key=${secret}`,
  }], "user-secret"));
  manager.appendLabelChange(labeledEntryId, `private label ${secret}`);
  manager.appendMessage(message("assistant", [{ type: "text", text: `received ${secret}` }], "assistant-secret"));
  const output = join(root, "share.html");

  exportSessionFile(manager.getSessionFile()!, output, { redact: true });
  const data = embeddedData(await readFile(output, "utf8"));
  const serialized = JSON.stringify(data);
  assert.equal(data.redacted, true);
  assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  assert.doesNotMatch(data.jsonl, new RegExp(secret, "u"));
  assert.match(data.jsonl, /\[REDACTED\]/u);
  assert.match(serialized, /\[REDACTED\]/u);
  const projected = parseSessionV4Bytes(Buffer.from(data.jsonl, "utf8"));
  assert.equal(
    data.tree.nodes.find((node) => node.id === labeledEntryId)?.label,
    projected.state.labels.get(labeledEntryId),
  );

  const ordinary = buildSessionExportData(manager);
  assert.match(ordinary.jsonl, new RegExp(secret, "u"));
  assert.equal(ordinary.tree.nodes.find((node) => node.id === labeledEntryId)?.label, `private label ${secret}`);
  assert.equal(ordinary.redacted, undefined);
});

test("redacted export omits secret-bearing keys from arbitrary session payloads", async () => {
  const { manager } = await managerFixture("redacted-payload-key");
  const secretKey = "session-export-secret-key";
  defaultSecretRedactor.register(secretKey);
  manager.appendMessage({
    ...message("assistant", [{
      type: "tool_call",
      callId: "call-key",
      name: "inspect",
      arguments: { safe: "visible", [secretKey]: "hidden" },
    }], "assistant-key"),
    providerState: {
      kind: "openai_responses",
      outputItems: [{ safe: "visible", [secretKey]: "hidden" }],
    },
  });
  manager.appendCustomEntry("extension-state", { safe: "visible", [secretKey]: "hidden" });

  const ordinary = buildSessionExportData(manager);
  assert.equal("providerState" in (ordinary.entries[0] as { message: object }).message, true);
  const data = buildSessionExportData(manager, { redact: true });
  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, new RegExp(secretKey, "u"));
  assert.doesNotThrow(() => parseSessionV4Bytes(Buffer.from(data.jsonl, "utf8")));
  assert.equal(data.entries[0]?.type, "message");
  assert.equal("providerState" in (data.entries[0] as { message: object }).message, false);
  assert.equal(data.entries[1]?.type, "custom");
});

test("export tree preserves labels, multiple roots, active ancestry and branch deep links", async () => {
  const { manager } = await managerFixture("tree");
  const firstRoot = manager.appendMessage(message("user", [{ type: "text", text: "first root" }], "m1"));
  manager.appendMessage(message("assistant", [{ type: "text", text: "first child" }], "m2"));
  manager.branch(firstRoot);
  const alternate = manager.appendMessage(message("user", [{ type: "text", text: "alternate" }], "m3"));
  manager.appendLabelChange(alternate, "chosen <branch>");
  manager.resetLeaf();
  const secondRoot = manager.appendMessage(message("user", [{ type: "text", text: "second root" }], "m4"));
  manager.branch(alternate);

  const data = buildSessionExportData(manager);
  assert.deepEqual(data.tree.roots, [firstRoot, secondRoot]);
  assert.deepEqual(data.tree.activePath, [firstRoot, alternate]);
  assert.equal(data.tree.nodes.find((node) => node.id === alternate)?.label, "chosen <branch>");
  assert.equal(data.leafId, alternate);

  const document = renderSessionHtml(manager);
  assert.match(document, /URLSearchParams/u);
  assert.match(document, /leafId/u);
  assert.match(document, /targetId/u);
  assert.match(document, /data-filter="labeled"/u);
  assert.match(document, /Search the session/u);
});

test("historical totals cover assistant, tool, compaction and branch-summary usage", async () => {
  const { manager } = await managerFixture("usage");
  const first = manager.appendMessage(message("user", [{ type: "text", text: "usage" }], "user"));
  manager.appendMessage({ ...message("assistant", [{ type: "text", text: "answer" }], "assistant"), usage: usage(1) });
  manager.appendMessage({
    ...message("tool", [{ type: "tool_result", callId: "tool", name: "review", content: "ok", isError: false }], "tool"),
    usage: usage(2),
  });
  manager.appendCompaction("compact", first, 400, undefined, false, usage(3));
  manager.branchWithSummary(first, "abandoned", undefined, false, usage(4));

  const total = sessionExportUsage(manager.getEntries());
  assert.deepEqual(total, {
    inputTokens: 10,
    outputTokens: 14,
    cacheReadTokens: 18,
    cacheWriteTokens: 22,
    reasoningTokens: 26,
    totalTokens: 64,
    cost: { input: 0.1, output: 0.14, cacheRead: 0.18, cacheWrite: 0.22, total: 0.64 },
  });
  assert.deepEqual(buildSessionExportData(manager).usage, total);
});

test("historical totals preserve missing, zero, and partial cache telemetry", async () => {
  const { manager } = await managerFixture("usage-availability");
  manager.appendMessage({
    ...message("assistant", [{ type: "text", text: "first" }], "first"),
    usage: {
      inputTokens: 4,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 2,
      totalTokens: 7,
    },
  });
  manager.appendMessage({
    ...message("assistant", [{ type: "text", text: "second" }], "second"),
    usage: { inputTokens: 3, outputTokens: 1, cacheWriteTokens: 0, totalTokens: 4 },
  });

  const total = sessionExportUsage(manager.getEntries());
  assert.equal(Object.hasOwn(total, "cacheReadTokens"), false);
  assert.equal(total.cacheReadTokensReported, 0);
  assert.equal(total.cacheWriteTokens, 2);
  assert.equal(total.totalTokens, 11);
});

test("historical totals distinguish exact zero from entirely missing cache telemetry", async (context) => {
  const zeroFixture = await managerFixture("usage-zero");
  context.after(() => zeroFixture.manager.closeV4Store());
  zeroFixture.manager.appendMessage({
    ...message("assistant", [{ type: "text", text: "zero" }], "zero"),
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
    },
  });
  const zero = sessionExportUsage(zeroFixture.manager.getEntries());
  assert.equal(zero.cacheReadTokens, 0);
  assert.equal(zero.cacheWriteTokens, 0);
  assert.equal(zero.totalTokens, 2);

  const missingFixture = await managerFixture("usage-missing");
  context.after(() => missingFixture.manager.closeV4Store());
  missingFixture.manager.appendMessage({
    ...message("assistant", [{ type: "text", text: "missing" }], "missing"),
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  const missing = sessionExportUsage(missingFixture.manager.getEntries());
  assert.equal(Object.hasOwn(missing, "cacheReadTokens"), false);
  assert.equal(Object.hasOwn(missing, "cacheWriteTokens"), false);
  assert.equal(missing.totalTokens, 2);
});

test("historical totals retain partial reports without promoting missing metered usage to zero", async () => {
  const { manager } = await managerFixture("usage-partial-request");
  const complete = usage(2);
  manager.appendMessage({
    ...message("assistant", [{ type: "text", text: "complete" }], "complete"),
    provider: "provider-a",
    model: "model-a",
    stopReason: "stop",
    usage: complete,
  });
  manager.appendMessage({
    ...message("tool", [{ type: "tool_result", callId: "tool", name: "review", content: "ok", isError: false }], "tool"),
  });
  manager.appendMessage({
    ...message("assistant", [{ type: "text", text: "missing" }], "missing"),
    provider: "provider-a",
    model: "model-a",
    stopReason: "stop",
  });

  assert.deepEqual(sessionExportUsage(manager.getEntries()), {
    inputTokensReported: complete.inputTokens,
    outputTokensReported: complete.outputTokens,
    cacheReadTokensReported: complete.cacheReadTokens,
    cacheWriteTokensReported: complete.cacheWriteTokens,
    reasoningTokensReported: complete.reasoningTokens,
    totalTokensReported: complete.totalTokens,
    costReported: complete.cost,
  });
});

test("historical provider totals stay exact when cache counters are only partially reported", async () => {
  const { manager } = await managerFixture("usage-independent-total");
  manager.appendMessage({
    ...message("assistant", [{ type: "text", text: "complete" }], "complete"),
    usage: usage(1),
  });
  manager.appendMessage({
    ...message("assistant", [{ type: "text", text: "partial" }], "partial"),
    usage: {
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      reasoningTokens: 1,
      cost: { input: 0.04, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.06 },
    },
  });

  const total = sessionExportUsage(manager.getEntries());
  assert.equal(total.inputTokens, 5);
  assert.equal(total.outputTokens, 4);
  assert.equal(total.totalTokens, 16);
  assert.equal(total.cacheReadTokens, undefined);
  assert.equal(total.cacheReadTokensReported, 3);
  assert.equal(total.cacheWriteTokens, undefined);
  assert.equal(total.cacheWriteTokensReported, 4);
  assert.deepEqual(total.cost, { input: 0.05, output: 0.04, cacheRead: 0.03, cacheWrite: 0.04, total: 0.16 });
  assert.equal(total.costReported, undefined);
});

test("historical totals ignore an unmetered extension summary", async () => {
  const { manager } = await managerFixture("usage-unmetered-summary");
  const first = manager.appendMessage(message("user", [{ type: "text", text: "root" }], "root"));
  const modelUsage = usage(2);
  manager.appendMessage({
    ...message("assistant", [{ type: "text", text: "answer" }], "assistant"),
    provider: "provider-a",
    model: "model-a",
    stopReason: "stop",
    usage: modelUsage,
  });
  manager.appendCompaction("extension summary", first, 20, undefined, true);

  assert.deepEqual(sessionExportUsage(manager.getEntries()), {
    inputTokens: modelUsage.inputTokens,
    outputTokens: modelUsage.outputTokens,
    cacheReadTokens: modelUsage.cacheReadTokens,
    cacheWriteTokens: modelUsage.cacheWriteTokens,
    reasoningTokens: modelUsage.reasoningTokens,
    totalTokens: modelUsage.totalTokens,
    cost: modelUsage.cost,
  });
});

test("session export client labels unavailable and partial aggregate telemetry", () => {
  assert.match(SESSION_EXPORT_CLIENT, /reported \(partial\)/u);
  assert.match(SESSION_EXPORT_CLIENT, /unavailable/u);
});

test("live metadata includes prompt, active tool schemas, skills, images and safe rendered tool rows", async () => {
  const { manager } = await managerFixture("metadata");
  manager.appendMessage({
    ...message("system", [{ type: "text", text: "System instructions" }], "system"),
    purpose: "instructions",
  });
  manager.appendMessage(message("user", [{
    type: "image",
    mediaType: "image/png",
    data: "iVBORw0KGgo=",
  }], "image"));
  manager.appendMessage(message("assistant", [{
    type: "tool_call",
    callId: "custom-call",
    name: "review",
    arguments: { scope: "all" },
  }], "assistant"));
  manager.appendMessage(message("tool", [{
    type: "tool_result",
    callId: "custom-call",
    name: "review",
    content: "line one\n  line two",
    contentBlocks: [
      { type: "text", text: "line one" },
      { type: "image", mediaType: "image/png", data: "private-renderer-image" },
      { type: "text", text: "line two" },
    ],
    isError: false,
    status: "warning",
    summary: "Needs review",
    nextActions: ["inspect"],
    usage: { inputTokens: 4, raw: { secret: "provider-raw" } } as never,
    addedToolNames: ["inspect"],
  }], "tool"));
  const resultViews: Array<Parameters<RuntimeToolRendererBinding["renderResult"]>[1]> = [];
  const renderer: RuntimeToolRendererBinding = {
    has: (name) => name === "review",
    renderCall: () => ({ lines: [{ spans: [{ text: "<renderer call>", role: "accent" }] }] }),
    renderResult: (_name, view) => {
      resultViews.push(view);
      return { lines: [{ spans: [{ text: view.expanded ? "expanded" : "collapsed" }] }] };
    },
  };
  const data = buildSessionExportData(manager, {
    tools: [{ name: "review", description: "Review code", inputSchema: { type: "object" }, active: true }],
    skills: [{ name: "audit", description: "Audit a workspace" }],
    toolRenderer: renderer,
  });

  assert.equal(data.systemPrompt, "System instructions");
  assert.deepEqual(data.tools, [{ name: "review", description: "Review code", inputSchema: { type: "object" }, active: true }]);
  assert.deepEqual(data.skills, [{ name: "audit", description: "Audit a workspace" }]);
  assert.equal(data.renderedTools?.["custom-call"]?.call?.lines[0]?.spans[0]?.text, "<renderer call>");
  assert.equal(data.renderedTools?.["custom-call"]?.resultCollapsed?.lines[0]?.spans[0]?.text, "collapsed");
  assert.equal(data.renderedTools?.["custom-call"]?.resultExpanded?.lines[0]?.spans[0]?.text, "expanded");
  assert.equal(resultViews.length, 2);
  assert.deepEqual(resultViews[0]?.result?.contentBlocks, [
    { type: "text", text: "line one" },
    { type: "image", mediaType: "image/png", index: 1 },
    { type: "text", text: "line two" },
  ]);
  assert.equal(resultViews[0]?.result?.status, "warning");
  assert.equal(resultViews[0]?.result?.summary, "Needs review");
  assert.deepEqual(resultViews[0]?.result?.nextActions, ["inspect"]);
  assert.deepEqual(resultViews[0]?.result?.usage, { inputTokens: 4 });
  assert.deepEqual(resultViews[0]?.result?.addedToolNames, ["inspect"]);
  assert.doesNotMatch(JSON.stringify(resultViews), /private-renderer-image|provider-raw/u);
  assert.equal(Object.isFrozen(resultViews[0]?.result?.contentBlocks), true);
});

test("custom renderer byte truncation preserves complete UTF-8 code points", async () => {
  const { manager } = await managerFixture("renderer-utf8-boundary");
  manager.appendMessage(message("assistant", [{
    type: "tool_call",
    callId: "utf8-call",
    name: "review",
    arguments: {},
  }], "assistant"));
  const data = buildSessionExportData(manager, {
    toolRenderer: {
      has: () => true,
      renderCall: () => ({
        lines: [{ spans: [
          { text: "a" },
          { text: "🚀".repeat(2 * 1024 * 1024) },
        ] }],
      }),
      renderResult: () => undefined,
    },
  });
  const rendered = data.renderedTools?.["utf8-call"]?.call;
  assert.ok(rendered);
  const retained = rendered.lines[0]?.spans.map((span) => span.text).join("") ?? "";
  const allText = rendered.lines.flatMap((line) => line.spans.map((span) => span.text)).join("");
  assert.ok(Buffer.byteLength(retained, "utf8") <= 8 * 1024 * 1024);
  assert.doesNotMatch(allText, /\ufffd/u);
  assert.equal(allText.includes("renderer output truncated"), true);
});

test("custom renderer reports byte truncation only when content is omitted", async () => {
  const { manager } = await managerFixture("renderer-exact-byte-boundary");
  manager.appendMessage(message("assistant", [
    { type: "tool_call", callId: "exact", name: "review", arguments: {} },
    { type: "tool_call", callId: "over", name: "review", arguments: {} },
  ], "assistant"));
  const maximumBytes = 8 * 1024 * 1024;
  const data = buildSessionExportData(manager, {
    toolRenderer: {
      has: () => true,
      renderCall: (_name, view) => ({
        lines: [{ spans: [{ text: "a".repeat(maximumBytes + (view.callId === "over" ? 1 : 0)) }] }],
      }),
      renderResult: () => undefined,
    },
  });

  const exact = data.renderedTools?.exact?.call;
  const over = data.renderedTools?.over?.call;
  assert.ok(exact);
  assert.ok(over);
  assert.equal(Buffer.byteLength(exact.lines[0]?.spans[0]?.text ?? "", "utf8"), maximumBytes);
  assert.doesNotMatch(JSON.stringify(exact), /renderer output truncated/u);
  assert.equal(Buffer.byteLength(over.lines[0]?.spans[0]?.text ?? "", "utf8"), maximumBytes);
  assert.match(JSON.stringify(over), /renderer output truncated/u);
});

test("persisted tool renderer calls report honest execution lifecycle state", async () => {
  const { manager } = await managerFixture("renderer-lifecycle");
  manager.appendMessage(message("assistant", [
    { type: "tool_call", callId: "succeeded", name: "review", arguments: { value: 1 } },
    { type: "tool_call", callId: "failed", name: "review", arguments: { value: 2 } },
    { type: "tool_call", callId: "unmatched", name: "review", arguments: { value: 3 } },
  ], "assistant"));
  manager.appendMessage(message("tool", [
    { type: "tool_result", callId: "succeeded", name: "review", content: "ok", isError: false },
    { type: "tool_result", callId: "failed", name: "review", content: "no", isError: true },
  ], "tool"));
  const callViews: Array<Parameters<RuntimeToolRendererBinding["renderCall"]>[1]> = [];
  buildSessionExportData(manager, {
    toolRenderer: {
      has: () => true,
      renderCall: (_name, view) => {
        callViews.push(view);
        return { lines: [{ spans: [{ text: view.callId }] }] };
      },
      renderResult: () => undefined,
    },
  });

  assert.deepEqual(callViews.map(({ callId, executionStarted, status }) => ({
    callId,
    executionStarted,
    status,
  })), [
    { callId: "succeeded", executionStarted: true, status: "completed" },
    { callId: "failed", executionStarted: true, status: "failed" },
    { callId: "unmatched", executionStarted: false, status: "pending" },
  ]);
});

test("HTML export reports renderer failures once per slot through a bounded redacted channel", async () => {
  const { manager } = await managerFixture("renderer-diagnostics");
  manager.appendMessage(message("assistant", [{
    type: "tool_call",
    callId: "failed-call",
    name: "review",
    arguments: {},
  }], "assistant"));
  manager.appendMessage(message("tool", [{
    type: "tool_result",
    callId: "failed-call",
    name: "review",
    content: "failed",
    isError: true,
  }], "tool"));
  const diagnostics: Array<{ name: string; slot: string; message: string }> = [];
  const secret = "sk-proj-abcdefghijklmnopqrstuvwx";
  buildSessionExportData(manager, {
    toolRenderer: {
      has: () => true,
      renderCall: () => { throw new Error(`renderer ${secret}`); },
      renderResult: () => { throw new Error(`renderer ${secret}`); },
    },
    onToolRendererDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
  });

  assert.deepEqual(diagnostics.map(({ name, slot }) => ({ name, slot })), [
    { name: "review", slot: "call" },
    { name: "review", slot: "result" },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(secret, "u"));
});

test("HTML export contains hostile renderer failures without invoking conversion hooks", async () => {
  const { manager } = await managerFixture("hostile-renderer-diagnostics");
  manager.appendMessage(message("assistant", [{
    type: "tool_call",
    callId: "hostile-call",
    name: "review",
    arguments: {},
  }], "assistant"));
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
  });
  const diagnostics: Array<{ name: string; slot: string; message: string }> = [];

  assert.doesNotThrow(() => buildSessionExportData(manager, {
    toolRenderer: {
      has: () => true,
      renderCall: () => { throw hostile; },
      renderResult: () => undefined,
    },
    onToolRendererDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
  }));

  assert.equal(traps, 0);
  assert.deepEqual(diagnostics, [{
    name: "review",
    slot: "call",
    message: "Runtime tool call renderer failed for review: [Thrown object]",
  }]);
});

test("session-derived HTML, attributes, Markdown and URLs remain data rather than executable markup", async () => {
  const { manager } = await managerFixture("security");
  const root = manager.appendMessage(message("user", [{
    type: "text",
    text: '<img src=x onerror=alert(1)> [bad](java\u0000script:alert(1)) [good](https://example.test/a?b=1&c=2) ![tracker](https://example.test/pixel.png)',
  }], "user"));
  manager.appendLabelChange(root, '"><script>alert(2)</script>');
  manager.appendCustomMessageEntry('"><svg/onload=alert(3)>', '<b onclick="alert(4)">plain</b>', true);
  const document = renderSessionHtml(manager);

  assert.doesNotMatch(document, /<script>alert\(2\)<\/script>/u);
  assert.doesNotMatch(document, /<svg\/onload/u);
  assert.doesNotMatch(document, /<b onclick=/u);
  assert.doesNotMatch(SESSION_EXPORT_CLIENT, /\.innerHTML\b/u);
  assert.match(SESSION_EXPORT_CLIENT, /textContent/u);
  const helpersStart = SESSION_EXPORT_CLIENT.indexOf("  function text(value)");
  const helpersEnd = SESSION_EXPORT_CLIENT.indexOf("  function externalImageUrl(value)", helpersStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
  const safeUrl = new Function(
    `"use strict";${SESSION_EXPORT_CLIENT.slice(helpersStart, helpersEnd)}; return safeUrl;`,
  )() as (value: unknown, image: boolean) => string;
  assert.equal(safeUrl("java\u0000script:alert(1)", false), "");
  assert.equal(safeUrl(" data:text/html;base64,PHNjcmlwdD4=", true), "");
  assert.equal(safeUrl("https://example.test/path", false), "https://example.test/path");
  assert.equal(safeUrl("https://example.test/pixel.png", true), "");
  assert.equal(safeUrl("data:image/png;base64,iVBORw0KGgo=", true), "data:image/png;base64,iVBORw0KGgo=");
  assert.match(document, /img-src data:;/u);
  assert.doesNotMatch(document, /img-src data: https?:/u);
  assert.match(SESSION_EXPORT_CLIENT, /appendExternalImagePlaceholder/u);
  assert.match(SESSION_EXPORT_CLIENT, /External image not loaded/u);
  assert.match(SESSION_EXPORT_CLIENT, /sessionExportUtf8Bytes\(selected\) <= 16 \* 1024/u);
  assert.match(SESSION_EXPORT_CLIENT, /sessionExportOneLine\(description, 80\)/u);
  assert.doesNotThrow(() => new Function(SESSION_EXPORT_CLIENT));
});

test("theme selection has a deterministic fallback and viewer controls remain self-contained", async () => {
  const { manager } = await managerFixture("theme");
  manager.appendMessage(message("user", [{ type: "text", text: "hello" }], "user"));
  assert.equal(resolveSessionExportTheme("light"), "light");
  assert.equal(resolveSessionExportTheme("missing-theme"), "dark");
  assert.equal(buildSessionExportData(manager, { theme: "missing-theme" }).theme, "dark");
  assert.equal(buildSessionExportData(manager, { theme: "light" }).theme, "light");

  const document = renderSessionHtml(manager);
  assert.doesNotMatch(document, /<script[^>]+src=/u);
  assert.doesNotMatch(document, /<link[^>]+href=/u);
  assert.match(document, /--sidebar-width/u);
  assert.match(document, /localStorage/u);
  assert.match(document, /max-width: 760px/u);
  assert.match(document, /toggle-tools/u);
  assert.match(document, /toggle-thinking/u);
});

test("standalone export rejects a missing source before creating output", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-export-"));
  roots.add(root);
  assert.throws(() => exportSessionFile(join(root, "missing.jsonl"), join(root, "never.html")), /File not found/u);
});

test("standalone export bounds and validates its source before creating output", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-export-"));
  roots.add(root);
  const oversized = join(root, "oversized.jsonl");
  const oversizedOutput = join(root, "oversized.html");
  await writeFile(oversized, "", { mode: 0o600 });
  await truncate(oversized, MAX_SESSION_FILE_BYTES + 1);

  assert.throws(
    () => exportSessionFile(oversized, oversizedOutput),
    new RegExp(`Session file exceeds the limit of ${MAX_SESSION_FILE_BYTES}`, "u"),
  );
  await assert.rejects(lstat(oversizedOutput), { code: "ENOENT" });

  const directory = join(root, "directory.jsonl");
  const directoryOutput = join(root, "directory.html");
  await mkdir(directory);
  assert.throws(
    () => exportSessionFile(directory, directoryOutput),
    /Session path is not a regular file/u,
  );
  await assert.rejects(lstat(directoryOutput), { code: "ENOENT" });
});

test("session-derived HTML revalidates a backing file that grows after opening", async () => {
  const { manager } = await managerFixture("grown-backing-file");
  manager.appendMessage(message("user", [{ type: "text", text: "before growth" }], "user-growth"));
  const source = manager.getSessionFile();
  assert.ok(source);
  await truncate(source, MAX_SESSION_FILE_BYTES + 1);

  assert.throws(
    () => renderSessionHtml(manager),
    new RegExp(`Session file exceeds the limit of ${MAX_SESSION_FILE_BYTES}`, "u"),
  );
});

test("redacted export keeps a large tool catalog structurally valid", async () => {
  const { manager } = await managerFixture("large-redacted-catalog");
  manager.appendMessage(message("user", [{ type: "text", text: "inspect" }], "user"));
  const tools = Array.from({ length: 5_010 }, (_, index) => ({
    name: `tool-${index}`,
    description: `Tool ${index}`,
    inputSchema: { type: "object" as const, properties: { value: { type: "string" as const } } },
    active: true,
  }));

  const data = buildSessionExportData(manager, { redact: true, tools });

  assert.equal(data.tools?.length, tools.length);
  assert.equal(data.tools?.every((tool) => tool.inputSchema.type === "object"), true);
  assert.equal(data.tree.nodes.every((node) => typeof node.id === "string"), true);
});

test("redacted export preserves nested session discriminants that overlap a registered secret", async () => {
  const { manager } = await managerFixture("redacted-discriminant");
  defaultSecretRedactor.register("tool_call");
  manager.appendMessage(message("assistant", [{
    type: "tool_call",
    callId: "call-discriminant",
    name: "inspect",
    arguments: { path: "README.md" },
  }], "assistant-discriminant"));

  const data = buildSessionExportData(manager, { redact: true });
  const entry = data.entries[0];
  assert.equal(entry?.type, "message");
  if (entry?.type !== "message" || entry.message.role !== "assistant") {
    throw new Error("missing assistant export entry");
  }
  assert.equal(entry.message.content[0]?.type, "tool_call");
  assert.doesNotThrow(() => parseSessionV4Bytes(Buffer.from(data.jsonl, "utf8")));
});
