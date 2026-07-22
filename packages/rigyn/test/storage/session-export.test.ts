import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CanonicalMessage, NormalizedUsage } from "../../src/core/types.js";
import { SESSION_EXPORT_CLIENT } from "../../src/storage/session-export-client.js";
import {
  buildSessionExportData,
  exportSessionFile,
  renderSessionHtml,
  resolveSessionExportTheme,
  sanitizeSessionExportUrl,
  sessionExportUsage,
} from "../../src/storage/session-export.js";
import { SessionManager } from "../../src/storage/session-manager.js";
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

test("redacted export removes secrets from every embedded and downloadable representation", async () => {
  const { root, manager } = await managerFixture("redacted");
  const secret = "sk-proj-abcdefghijklmnopqrstuvwx";
  manager.appendSessionInfo(`token ${secret}`);
  manager.appendMessage(message("user", [{
    type: "text",
    text: `authorization: Bearer ${secret} api_key=${secret}`,
  }], "user-secret"));
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

  const ordinary = buildSessionExportData(manager);
  assert.match(ordinary.jsonl, new RegExp(secret, "u"));
  assert.equal(ordinary.redacted, undefined);
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
    isError: false,
  }], "tool"));
  const renderer: RuntimeToolRendererBinding = {
    has: (name) => name === "review",
    renderCall: () => ({ lines: [{ spans: [{ text: "<renderer call>", role: "accent" }] }] }),
    renderResult: (_name, view) => ({ lines: [{ spans: [{ text: view.expanded ? "expanded" : "collapsed" }] }] }),
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
});

test("session-derived HTML, attributes, Markdown and URLs remain data rather than executable markup", async () => {
  const { manager } = await managerFixture("security");
  const root = manager.appendMessage(message("user", [{
    type: "text",
    text: '<img src=x onerror=alert(1)> [bad](java\u0000script:alert(1)) [good](https://example.test/a?b=1&c=2)',
  }], "user"));
  manager.appendLabelChange(root, '"><script>alert(2)</script>');
  manager.appendCustomMessageEntry('"><svg/onload=alert(3)>', '<b onclick="alert(4)">plain</b>', true);
  const document = renderSessionHtml(manager);

  assert.doesNotMatch(document, /<script>alert\(2\)<\/script>/u);
  assert.doesNotMatch(document, /<svg\/onload/u);
  assert.doesNotMatch(document, /<b onclick=/u);
  assert.doesNotMatch(SESSION_EXPORT_CLIENT, /\.innerHTML\b/u);
  assert.match(SESSION_EXPORT_CLIENT, /textContent/u);
  assert.equal(sanitizeSessionExportUrl("java\u0000script:alert(1)", "link"), undefined);
  assert.equal(sanitizeSessionExportUrl(" data:text/html;base64,PHNjcmlwdD4=", "image"), undefined);
  assert.equal(sanitizeSessionExportUrl("https://example.test/path", "link"), "https://example.test/path");
  assert.equal(sanitizeSessionExportUrl("data:image/png;base64,iVBORw0KGgo=", "image"), "data:image/png;base64,iVBORw0KGgo=");
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
