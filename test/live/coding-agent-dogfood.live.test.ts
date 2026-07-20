import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import { loadRuntime, type LoadedRuntime } from "../../src/cli/runtime.js";
import type { EventEnvelope } from "../../src/core/events.js";
import type { ModelInfo } from "../../src/core/types.js";
import {
  discoverExtensions,
  loadRuntimeExtensions,
  LocalExtensionPackageManager,
  type RuntimeExtensionHost,
} from "../../src/extensions/index.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { bundledAuthoringResources } from "../../src/prompts/resources.js";
import { WorkspaceBoundary } from "../../src/tools/index.js";

const ENABLED = process.env.RIGYN_LIVE_DOGFOOD === "1";
const PROVIDER = process.env.RIGYN_LIVE_PROVIDER?.trim() || "openai";
const REQUESTED_MODEL = process.env.RIGYN_LIVE_MODEL?.trim();
const SCENARIOS = new Set((process.env.RIGYN_LIVE_DOGFOOD_SCENARIOS ?? "repair,extension")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const RUN_TIMEOUT_MS = 6 * 60_000;
const SUITE_TIMEOUT_MS = 14 * 60_000;
const MAX_OUTPUT_TOKENS = 2_048;
const MAX_CONTEXT_TOKENS = 64 * 1_024;
const MAX_REPORTED_COST_USD = 2;
const REPAIR_MAX_STEPS = 16;
const EXTENSION_MAX_STEPS = 40;

const PREFERRED_MODELS: Readonly<Record<string, readonly string[]>> = {
  openai: ["gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.4-nano", "gpt-4.1-mini"],
  anthropic: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-3.5-flash", "gemini-2.5-flash"],
  mistral: ["devstral-small-latest", "mistral-small-latest"],
  openrouter: ["openai/gpt-4.1-mini"],
};

interface SharedCostBudget {
  spentUsd: number;
  reported: boolean;
}

interface ToolRequestObservation {
  name: string;
  input: string;
}

interface LiveRunObservation {
  finishReason: string | undefined;
  finalText: string;
  steps: number;
  toolRequests: ToolRequestObservation[];
  toolErrors: number;
  warnings: string[];
  reportedCostUsd: number;
  reportedTokens: number;
}

function usageTokens(event: Extract<EventEnvelope["event"], { type: "usage" }>): number | undefined {
  return event.usage.totalTokens ?? (
    event.usage.inputTokens === undefined && event.usage.outputTokens === undefined
      ? undefined
      : (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0)
  );
}

async function selectLiveModel(runtime: LoadedRuntime): Promise<ModelInfo> {
  assert.equal(runtime.providers.has(PROVIDER), true, `requested live provider is not configured: ${PROVIDER}`);
  const auth = await runtime.auth.state(PROVIDER);
  assert.equal(auth.status, "connected", `requested live provider is not connected: ${PROVIDER}`);
  const models = await runtime.providers.listModels(PROVIDER, AbortSignal.timeout(30_000), {
    refresh: true,
    verifiedOnly: true,
  });
  let selected: ModelInfo | undefined;
  if (REQUESTED_MODEL !== undefined) {
    selected = models.find((model) => model.id === REQUESTED_MODEL);
    assert.ok(selected, `requested live model was not returned by ${PROVIDER}: ${REQUESTED_MODEL}`);
  } else {
    const configured = runtime.config.defaultProvider === PROVIDER ? runtime.config.defaultModel : undefined;
    selected = configured === undefined ? undefined : models.find((model) => model.id === configured);
    for (const id of PREFERRED_MODELS[PROVIDER] ?? []) {
      if (selected !== undefined) break;
      selected = models.find((model) => model.id === id && model.capabilities.tools.value !== "unsupported");
    }
    selected ??= models.find((model) => model.capabilities.tools.value !== "unsupported");
  }
  assert.ok(selected, `connected provider returned no tool-capable live model: ${PROVIDER}`);
  assert.notEqual(selected.capabilities.tools.value, "unsupported", `selected model does not support tools: ${selected.id}`);
  return selected;
}

async function createLiveRuntime(workspace: string, skills: boolean): Promise<{ runtime: LoadedRuntime; model: ModelInfo }> {
  const runtime = await loadRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionRuntime: false,
    skills,
    promptTemplates: false,
    themes: false,
    recover: false,
  });
  try {
    return { runtime, model: await selectLiveModel(runtime) };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

async function runLiveAgent(
  context: TestContext,
  runtime: LoadedRuntime,
  model: ModelInfo,
  input: {
    label: string;
    prompt: string;
    maxSteps: number;
    additionalInstructions?: string;
  },
  budget: SharedCostBudget,
): Promise<LiveRunObservation> {
  assert.ok(budget.spentUsd < MAX_REPORTED_COST_USD, "shared live dogfood cost budget is already exhausted");
  const thread = await runtime.service.createSession({ name: input.label, cwd: runtime.workspace });
  const observation: LiveRunObservation = {
    finishReason: undefined,
    finalText: "",
    steps: 0,
    toolRequests: [],
    toolErrors: 0,
    warnings: [],
    reportedCostUsd: 0,
    reportedTokens: 0,
  };
  let responseCost = 0;
  let responseTokens = 0;
  let cancellationReason: string | undefined;
  const cancel = (reason: string): void => {
    if (cancellationReason !== undefined) return;
    cancellationReason = reason;
    runtime.service.cancel(thread.threadId, reason);
  };
  const timer = setTimeout(() => cancel(`${input.label} exceeded ${RUN_TIMEOUT_MS}ms`), RUN_TIMEOUT_MS);
  timer.unref();
  const observe = (envelope: EventEnvelope): void => {
    const event = envelope.event;
    if (event.type === "assistant_started") observation.steps = Math.max(observation.steps, event.step);
    else if (event.type === "provider_response_started") {
      responseCost = 0;
      responseTokens = 0;
    } else if (event.type === "tool_requested") {
      observation.toolRequests.push({ name: event.name, input: JSON.stringify(event.input) });
    } else if (event.type === "tool_completed" && event.isError) observation.toolErrors += 1;
    else if (event.type === "warning" && observation.warnings.length < 20) observation.warnings.push(event.code);
    else if (event.type === "usage") {
      const cost = event.usage.cost === undefined ? undefined : Number(event.usage.cost);
      if (cost !== undefined && Number.isFinite(cost) && cost >= 0) {
        budget.reported = true;
        const delta = event.semantics === "incremental" ? cost : Math.max(0, cost - responseCost);
        if (event.semantics !== "incremental") responseCost = Math.max(responseCost, cost);
        budget.spentUsd += delta;
        observation.reportedCostUsd += delta;
        if (budget.spentUsd > MAX_REPORTED_COST_USD) {
          cancel(`shared live dogfood cost exceeded $${MAX_REPORTED_COST_USD.toFixed(2)}`);
        }
      }
      const tokens = usageTokens(event);
      if (tokens !== undefined) {
        const delta = event.semantics === "incremental" ? tokens : Math.max(0, tokens - responseTokens);
        if (event.semantics !== "incremental") responseTokens = Math.max(responseTokens, tokens);
        observation.reportedTokens += delta;
      }
    }
  };

  try {
    const run = await runtime.service.run({
      threadId: thread.threadId,
      prompt: input.prompt,
      provider: PROVIDER,
      model: model.id,
      maxSteps: input.maxSteps,
      maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS, model.maxOutputTokens ?? MAX_OUTPUT_TOKENS),
      contextTokenBudget: Math.min(MAX_CONTEXT_TOKENS, model.contextTokens ?? MAX_CONTEXT_TOKENS),
      allowedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      noContextFiles: true,
      ...(input.additionalInstructions === undefined
        ? {}
        : { additionalInstructions: { text: input.additionalInstructions, source: "live dogfood boundary" } }),
      onEvent: observe,
    });
    const completed = run.results.at(-1);
    observation.finishReason = completed?.finishReason;
    observation.finalText = completed?.finalText ?? "";
    observation.steps = Math.max(observation.steps, completed?.steps ?? 0);
    if (cancellationReason !== undefined) throw new Error(cancellationReason);
    assert.equal(completed?.finishReason, "stop", `${input.label} did not finish normally`);
    assert.ok(observation.steps <= input.maxSteps, `${input.label} exceeded its turn bound`);
    return observation;
  } finally {
    clearTimeout(timer);
    context.diagnostic(JSON.stringify({
      scenario: input.label,
      provider: PROVIDER,
      model: model.id,
      finishReason: observation.finishReason ?? "unavailable",
      steps: observation.steps,
      tools: observation.toolRequests.map((entry) => entry.name),
      toolErrors: observation.toolErrors,
      warnings: observation.warnings,
      reportedTokens: observation.reportedTokens,
      reportedCostUsd: budget.reported ? observation.reportedCostUsd.toFixed(6) : "unreported",
      sharedReportedCostUsd: budget.reported ? budget.spentUsd.toFixed(6) : "unreported",
    }));
  }
}

async function runBoundedNodeTest(cwd: string, testPath: string): Promise<void> {
  const child = spawn(process.execPath, ["--test", testPath], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
    },
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output: Buffer[] = [];
  let bytes = 0;
  let failure: Error | undefined;
  const stop = (error: Error): void => {
    if (failure !== undefined) return;
    failure = error;
    if (child.pid !== undefined && process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    } else child.kill("SIGKILL");
  };
  const capture = (chunk: Buffer): void => {
    if (failure !== undefined) return;
    bytes += chunk.byteLength;
    if (bytes > 64 * 1_024) stop(new Error("independent test output exceeded 65536 bytes"));
    else output.push(Buffer.from(chunk));
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timeout = setTimeout(() => stop(new Error("independent test timed out after 30000ms")), 30_000);
  timeout.unref();
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (failure !== undefined) throw failure;
  if (result.code !== 0) {
    const detail = Buffer.concat(output).toString("utf8").slice(-4_096);
    throw new Error(`independent test failed (${result.code ?? result.signal ?? "unknown"}): ${detail}`);
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertToolResult(host: RuntimeExtensionHost, workspace: string, text: string): Promise<void> {
  const tool = host.tools().find((entry) => entry.definition.name === "dogfood_echo");
  assert.ok(tool, "authored package did not register dogfood_echo");
  const input = { text };
  tool.validate(input);
  const result = await tool.execute(input, {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: AbortSignal.timeout(10_000),
    runId: `run-${text.toLowerCase()}`,
    threadId: `thread-${text.toLowerCase()}`,
  });
  assert.equal(result.isError, false);
  assert.equal(result.status, "success");
  assert.equal(typeof result.summary, "string");
  assert.ok((result.summary ?? "").length > 0 && (result.summary ?? "").length <= 1_024);
  assert.deepEqual(result.nextActions, []);
  const content = JSON.parse(result.content) as { echo?: unknown };
  assert.equal(content.echo, text);
}

test("credential-gated live coding-agent dogfood", { skip: !ENABLED, timeout: SUITE_TIMEOUT_MS }, async (context) => {
  const budget: SharedCostBudget = { spentUsd: 0, reported: false };

  await context.test("repairs a broken repository and preserves unrelated work", {
    skip: !SCENARIOS.has("repair"),
  }, async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "harness-live-repair-"));
    scenario.after(async () => await rm(root, { recursive: true, force: true }));
    const sourceRoot = join(root, "src");
    const testRoot = join(root, "test");
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(testRoot, { recursive: true });
    const sentinel = "DOGFOOD_SENTINEL_MUST_REMAIN_BYTE_FOR_BYTE\n";
    const testSource = `
import assert from "node:assert/strict";
import test from "node:test";
import { average, total } from "../src/math.mjs";
test("total adds finite values", () => assert.equal(total([4, -1, 7]), 10));
test("average handles values and an empty list", () => {
  assert.equal(average([2, 4, 6]), 4);
  assert.equal(average([]), 0);
});
test("non-finite values are rejected", () => assert.throws(() => total([1, Number.NaN]), /finite/u));
`;
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "live-broken-repository",
      private: true,
      type: "module",
      scripts: { test: "node --test test/math.test.mjs" },
    }, null, 2)}\n`);
    await writeFile(join(sourceRoot, "math.mjs"), `
export function total(values) {
  return values.reduce((sum, value) => sum - value, 0);
}
export function average(values) {
  return total(values) / (values.length - 1);
}
`);
    await writeFile(join(testRoot, "math.test.mjs"), testSource);
    await writeFile(join(root, "UNRELATED_SENTINEL.md"), sentinel);

    const { runtime, model } = await createLiveRuntime(root, false);
    try {
      const observation = await runLiveAgent(scenario, runtime, model, {
        label: "repair-broken-repo",
        maxSteps: REPAIR_MAX_STEPS,
        prompt: [
          "Repair this intentionally broken JavaScript repository.",
          "Inspect the implementation and existing tests, change only src/math.mjs, and run npm test before finishing.",
          "Do not edit package.json, test files, or UNRELATED_SENTINEL.md. Keep the fix minimal and do not add dependencies.",
          "Finish only after the existing tests pass.",
        ].join(" "),
      }, budget);
      assert.equal(observation.toolRequests.some((entry) =>
        entry.name === "bash" && /npm test|node --test/u.test(entry.input)), true, "agent did not run the repository tests");
    } finally {
      await runtime.close();
    }

    await runBoundedNodeTest(root, "test/math.test.mjs");
    assert.equal(await readFile(join(root, "UNRELATED_SENTINEL.md"), "utf8"), sentinel);
    assert.equal(await readFile(join(testRoot, "math.test.mjs"), "utf8"), testSource);
    assert.match(await readFile(join(sourceRoot, "math.mjs"), "utf8"), /finite/u);
  });

  await context.test("authors and survives reload of a fresh structured-tool extension", {
    skip: !SCENARIOS.has("extension"),
  }, async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "harness-live-extension-"));
    scenario.after(async () => await rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const packageRoot = join(workspace, "dogfood-extension");
    const managedRoot = join(root, "managed");
    await mkdir(workspace, { recursive: true });
    const resources = bundledAuthoringResources();
    const readOnlyReferences = [
      resources.authoringSkill,
      join(resources.documentationRoot, "extensions.md"),
      join(resources.documentationRoot, "packages.md"),
      join(resources.examplesRoot, "package-starter", "README.md"),
      join(resources.examplesRoot, "package-starter", "extension.json"),
      join(resources.examplesRoot, "package-starter", "runtime", "index.mjs"),
      join(resources.examplesRoot, "custom-tool", "README.md"),
      join(resources.examplesRoot, "custom-tool", "extension.json"),
      join(resources.examplesRoot, "custom-tool", "runtime", "index.mjs"),
      join(resources.examplesRoot, "custom-tool", "runtime.activation.mjs"),
    ];
    const referenceHashes = new Map(await Promise.all(readOnlyReferences.map(async (path) => [path, await hashFile(path)] as const)));

    const { runtime, model } = await createLiveRuntime(workspace, true);
    try {
      const observation = await runLiveAgent(scenario, runtime, model, {
        label: "author-fresh-extension",
        maxSteps: EXTENSION_MAX_STEPS,
        additionalInstructions: [
          `All writes must stay under ${workspace}.`,
          "Bundled Rigyn documentation, skills, and examples are read-only references.",
          "Never install the package globally or into the user's Rigyn directories.",
        ].join(" "),
        prompt: [
          "Use the advertised build-extension skill to create a fresh package at dogfood-extension/.",
          "First read the build-extension SKILL.md and the extensions/package documentation it routes to, then inspect only the focused package-starter and custom-tool examples.",
          "Create extension.json, runtime/index.mjs, package.json, README.md, and test/dogfood.test.mjs.",
          "Register exactly one model-callable tool named dogfood_echo with a closed schema requiring one string field named text.",
          "For valid input, return isError false, top-level status success, a non-empty summary, an empty nextActions array, and a content string whose parsed JSON is shaped as {\"echo\": <the exact input>}. Never return an object directly as content.",
          "Add and run a deterministic node:test covering activation, schema, and the structured result, including typeof result.content === 'string' before parsing it.",
          "Inspect the test exit status and output; if it fails, fix the package or test and rerun it. Finish only after the test passes.",
          "This temporary project has no host dependency installed: the test must import only Node built-ins and local package files, use a minimal local activation host stub, and must not import rigyn or rigyn/extensions.",
          "Do not install the package; the independent verifier will install, reload, invoke, and remove it.",
        ].join(" "),
      }, budget);
      const inspected = (path: string): boolean => {
        const candidates = [
          path,
          relative(resources.packageRoot, path),
          relative(dirname(resources.authoringSkill), path),
        ].map((entry) => entry.replaceAll("\\", "/"));
        return observation.toolRequests.some((entry) =>
          ["read", "bash", "grep"].includes(entry.name)
          && candidates.some((candidate) => entry.input.replaceAll("\\", "/").includes(candidate)));
      };
      assert.equal(inspected(resources.authoringSkill), true,
      "agent did not load the bundled build-extension skill");
      assert.equal(inspected(join(resources.documentationRoot, "extensions.md")), true,
      "agent did not read the bundled extension documentation");
      assert.equal(observation.toolRequests.some((entry) =>
        entry.name === "bash" && /node --test|npm test/u.test(entry.input)), true,
      "agent did not run the authored package test");
    } finally {
      await runtime.close();
    }

    for (const [path, digest] of referenceHashes) {
      assert.equal(await hashFile(path), digest, `agent modified bundled read-only reference: ${path}`);
    }
    await runBoundedNodeTest(packageRoot, "test/dogfood.test.mjs");

    const manager = new LocalExtensionPackageManager({ user: managedRoot });
    let installedId: string | undefined;
    let host: RuntimeExtensionHost | undefined;
    try {
      const installed = await manager.install(packageRoot);
      installedId = installed.id;
      const firstCatalog = await discoverExtensions(manager.sources(true));
      assert.equal(firstCatalog.doctor().healthy, true);
      assert.equal(firstCatalog.list().find((entry) => entry.id === installed.id)?.status, "active");
      host = await loadRuntimeExtensions(firstCatalog.bundle().runtime, { workspace });
      assert.deepEqual(host.diagnostics(), []);
      await assertToolResult(host, workspace, "DOGFOOD_FIRST");
      await host.close();
      host = undefined;

      const reloadedCatalog = await discoverExtensions(manager.sources(true));
      host = await loadRuntimeExtensions(reloadedCatalog.bundle().runtime, { workspace });
      assert.deepEqual(host.diagnostics(), []);
      await assertToolResult(host, workspace, "DOGFOOD_SECOND");
    } finally {
      await host?.close().catch(() => undefined);
      if (installedId !== undefined) {
        const stillInstalled = (await manager.list("user")).some((entry) => entry.id === installedId);
        if (stillInstalled) await manager.remove(installedId);
      }
    }
    assert.deepEqual(await manager.list("user"), []);
    await assert.rejects(access(join(managedRoot, installedId ?? "dogfood-extension")), /ENOENT/u);
  });
});
