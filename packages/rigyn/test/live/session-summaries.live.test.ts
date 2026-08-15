import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";
import type { AgentSessionModel } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { liveCredentialStore } from "./credentials.js";

const ENABLED = process.env.RIGYN_LIVE_SESSION === "1"
  || process.env.npm_lifecycle_event === "test:live:session";
const PROVIDER = process.env.RIGYN_LIVE_PROVIDER?.trim() || "openai-codex";
const MODEL = process.env.RIGYN_LIVE_MODEL?.trim() || "gpt-5.6-terra";

function appendTurn(
  manager: SessionManager,
  model: AgentSessionModel,
  index: number,
  body: string,
): { user: string; assistant: string } {
  const timestamp = new Date(Date.UTC(2026, 6, 28, 0, 0, index * 2));
  const user = manager.appendMessage({
    id: `live-summary-user-${index}`,
    role: "user",
    content: [{ type: "text", text: `Question ${index}: ${body}` }],
    createdAt: timestamp.toISOString(),
  });
  timestamp.setUTCSeconds(timestamp.getUTCSeconds() + 1);
  const assistant = manager.appendMessage({
    id: `live-summary-assistant-${index}`,
    role: "assistant",
    content: [{ type: "text", text: `Answer ${index}: ${body}` }],
    createdAt: timestamp.toISOString(),
    provider: model.provider,
    api: model.api,
    model: model.id,
    stopReason: "stop",
  });
  return { user, assistant };
}

test("live session compaction and branch summaries remain usable", {
  skip: !ENABLED,
  timeout: 8 * 60_000,
}, async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-live-session-"));
  const sessions = join(workspace, "sessions");
  let runtime: Awaited<ReturnType<typeof loadRuntime>> | undefined;
  context.after(async () => {
    await runtime?.close();
    await rm(workspace, { recursive: true, force: true });
  });
  runtime = await loadRuntime({
    workspace,
    credentialStore: await liveCredentialStore(),
    projectTrusted: false,
    ephemeral: false,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    sessionDirectory: sessions,
  });

  const selected = await runtime.session.resolveModel(MODEL, {
    provider: PROVIDER,
    signal: AbortSignal.timeout(30_000),
  });
  await runtime.session.setModel(selected);
  runtime.session.setThinkingLevel("max");
  assert.equal(runtime.session.model?.provider, PROVIDER);
  assert.equal(runtime.session.model?.id, MODEL);
  assert.equal(runtime.session.thinkingLevel, "max");

  await context.test("manual compaction persists a summary and retained tail", async () => {
    const events: string[] = [];
    const unsubscribe = runtime.session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") events.push(event.type);
    });
    try {
      const repeated = "stable live compaction history ".repeat(350);
      for (let index = 0; index < 12; index += 1) {
        appendTurn(runtime.sessionManager, selected, index, `${repeated} marker-${index}`);
      }

      const result = await runtime.session.compact(
        "Write a concise factual summary. Preserve the numbered marker values.",
      );

      assert.notEqual(result.summary.trim(), "");
      assert.ok(runtime.sessionManager.getEntry(result.firstKeptEntryId));
      assert.deepEqual(events, ["compaction_start", "compaction_end"]);
      assert.equal(runtime.session.isIdle, true);
      const compaction = runtime.sessionManager.getBranch()
        .findLast((entry) => entry.type === "compaction");
      assert.equal(compaction?.type, "compaction");
      assert.equal(compaction?.type === "compaction" ? compaction.summary : "", result.summary);

      const file = runtime.session.sessionFile;
      assert.ok(file);
      const reopened = SessionManager.openSnapshot(file);
      assert.equal(reopened.getEntries().some((entry) => entry.type === "compaction"), true);
      assert.equal(reopened.buildSessionContext().messages[0]?.role, "compactionSummary");
    } finally {
      unsubscribe();
    }
  });

  await context.test("branch summary preserves navigation and supports the next turn", async () => {
    runtime.session.newSession();
    const first = appendTurn(runtime.sessionManager, selected, 20, "root marker");
    appendTurn(runtime.sessionManager, selected, 21, "abandoned marker one");
    appendTurn(runtime.sessionManager, selected, 22, "abandoned marker two");

    const result = await runtime.session.navigateTree(first.assistant, {
      summarize: true,
      customInstructions: "Summarize the abandoned markers in one short paragraph.",
    });

    assert.equal(result.cancelled, false);
    assert.notEqual(result.summaryEntry?.summary.trim() ?? "", "");
    assert.equal(result.summaryEntry?.parentId, first.assistant);
    assert.equal(runtime.sessionManager.getLeafId(), result.summaryEntry?.id);
    assert.equal(runtime.session.isIdle, true);

    const continuation = await runtime.session.prompt("Reply with exactly TREE_OK.", {
      allowedTools: [],
      maxSteps: 1,
      maxOutputTokens: 1_024,
      noContextFiles: true,
    });
    assert.match(continuation.results.at(-1)?.finalText ?? "", /TREE_OK/u);
    assert.equal(runtime.session.model?.id, MODEL);
    assert.equal(runtime.session.thinkingLevel, "max");
  });
});
