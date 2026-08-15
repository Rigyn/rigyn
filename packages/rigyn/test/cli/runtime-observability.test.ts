import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listLocalObservabilityFiles } from "../../src/core/local-observability.js";
import {
  RuntimeObservability,
  type ObservabilityRecord,
  type ObservabilitySink,
} from "../../src/core/observability.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

class RecordingSink implements ObservabilitySink {
  readonly records: ObservabilityRecord[] = [];
  record(record: ObservabilityRecord): void { this.records.push(record); }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

test("the canonical CLI runtime records startup and shutdown without workspace content", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-observability-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "WORKSPACE_SENTINEL");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  const runtime = await loadRuntime({
    workspace,
    agentDirectory,
    projectTrusted: false,
    ephemeral: true,
    extensions: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
    localObservabilityMode: "print",
  });
  assert.equal(runtime.observability?.level, "debug");
  await runtime.close();

  const listed = await listLocalObservabilityFiles(join(agentDirectory, "logs"));
  assert.equal(listed.files.length, 1);
  const content = await readFile(join(listed.directory, listed.files[0]!.name), "utf8");
  const records = content.trim().split("\n").map((line) => JSON.parse(line) as ObservabilityRecord);
  assert.deepEqual(records.filter((record) => record.kind === "event").map((record) => record.name), [
    "runtime_loading",
    "runtime_loaded",
    "shutdown_started",
    "shutdown_completed",
  ]);
  assert.equal(records.at(-1)?.kind, "metrics_snapshot");
  assert.doesNotMatch(content, /WORKSPACE_SENTINEL/u);
});

test("global observability off avoids local files until a successful refresh enables it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-observability-off-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(join(agentDirectory, "config.json"), `${JSON.stringify({ observability: { level: "off" } })}\n`);
  const runtime = await loadRuntime({
    workspace,
    agentDirectory,
    projectTrusted: false,
    ephemeral: true,
    extensions: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
    localObservabilityMode: "print",
  });
  await assert.rejects(access(join(agentDirectory, "logs")));

  await writeFile(join(agentDirectory, "config.json"), `${JSON.stringify({ observability: { level: "info" } })}\n`);
  await assert.rejects(runtime.refresh({
    prepareSettings() { throw new Error("candidate rejected"); },
  }), /candidate rejected/u);
  assert.equal("observability" in runtime, false);
  assert.equal((await listLocalObservabilityFiles(join(agentDirectory, "logs"))).files.length, 0);

  await runtime.refresh();
  assert.equal(runtime.observability?.level, "info");
  await runtime.close();

  const listed = await listLocalObservabilityFiles(join(agentDirectory, "logs"));
  assert.equal(listed.files.length, 1);
  const content = await readFile(join(listed.directory, listed.files[0]!.name), "utf8");
  const records = content.trim().split("\n").map((line) => JSON.parse(line) as ObservabilityRecord);
  assert.deepEqual(records.filter((record) => record.kind === "event").map((record) => record.name), [
    "refresh_completed",
    "shutdown_started",
    "shutdown_completed",
  ]);
  assert.equal(records.at(-1)?.kind, "metrics_snapshot");
});

test("runtime lifecycle failures retain metadata without free-form diagnostic text", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-observability-errors-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  const sink = new RecordingSink();
  const runtime = await loadRuntime({
    workspace,
    agentDirectory,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: false,
    ephemeral: true,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
    observabilitySink: sink,
  });
  assert.equal(runtime.observability?.level, "debug");

  const warningResult = await runtime.refresh({
    onCommit() {
      throw new Error("REFRESH_WARNING_PRIVATE_SENTINEL");
    },
  });
  assert.equal(warningResult.warnings.length, 1);
  await assert.rejects(runtime.refresh({
    prepareSettings() {
      throw new Error("REFRESH_FAILURE_PRIVATE_SENTINEL");
    },
  }));

  const closeSession = runtime.session.close.bind(runtime.session);
  runtime.session.close = async () => {
    await closeSession();
    throw new Error("SHUTDOWN_FAILURE_PRIVATE_SENTINEL");
  };
  await assert.rejects(runtime.close());

  const refreshCompleted = sink.records.find((record) => record.name === "refresh_completed");
  const refreshFailed = sink.records.find((record) => record.name === "refresh_failed");
  const shutdownFailed = sink.records.find((record) => record.name === "shutdown_failed");
  assert.equal(refreshCompleted?.fields.warnings, 1);
  assert.equal(refreshCompleted?.fields.warning_summary, undefined);
  assert.equal(refreshFailed?.fields.error_message, undefined);
  assert.equal(shutdownFailed?.fields.failures, 1);
  assert.equal(shutdownFailed?.fields.error_message, undefined);
  const serialized = JSON.stringify([refreshCompleted, refreshFailed, shutdownFailed]);
  assert.doesNotMatch(
    serialized,
    /REFRESH_WARNING_PRIVATE_SENTINEL|REFRESH_FAILURE_PRIVATE_SENTINEL|SHUTDOWN_FAILURE_PRIVATE_SENTINEL/u,
  );
});

test("session initialization failures are visible to a caller-owned observer", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-observability-session-failure-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace), mkdir(agentDirectory)]);
  const sink = new RecordingSink();
  const observer = new RuntimeObservability(sink, { mode: "sdk", closeSink: false });

  await assert.rejects(loadRuntime({
    workspace,
    agentDirectory,
    credentialStore: new InMemoryCredentialStore(),
    sessionManager: SessionManager.inMemory(otherWorkspace),
    projectTrusted: false,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
    observability: observer,
  }), /SessionManager cwd/u);
  await observer.close();

  const failure = sink.records.find((record) =>
    record.name === "runtime_load_failed" && record.fields.stage === "session");
  assert.equal(failure?.fields.error_message, undefined);
  assert.doesNotMatch(JSON.stringify(failure), /SessionManager cwd/u);
});

test("runtime refresh applies observability levels only after committing the new settings", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-observability-refresh-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const settingsPath = join(agentDirectory, "config.json");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(settingsPath, `${JSON.stringify({ observability: { level: "info" } })}\n`);
  const sink = new RecordingSink();
  const observer = new RuntimeObservability(sink, { mode: "sdk", closeSink: false });
  const runtime = await loadRuntime({
    workspace,
    agentDirectory,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: false,
    ephemeral: true,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
    observability: observer,
  });

  await writeFile(settingsPath, `${JSON.stringify({ observability: { level: "off" } })}\n`);
  await assert.rejects(runtime.refresh({
    prepareSettings() { throw new Error("candidate rejected"); },
  }), /candidate rejected/u);
  assert.equal(observer.level, "info");

  await runtime.refresh();
  assert.equal(observer.level, "off");
  await runtime.close();
  await observer.close();

  assert.equal(sink.records.some((record) => record.name === "refresh_failed"), true);
  assert.equal(sink.records.filter((record) => record.name === "refresh_completed").length, 0);
});
