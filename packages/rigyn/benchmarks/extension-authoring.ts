import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DefaultPackageManager,
  type PackageActivationCandidate,
  type ResolvedPaths,
} from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { loadDirectExtensions, type RuntimeExtensionHost } from "../src/extensions/runtime.js";
import { limitText } from "../src/tools/output.js";

const EXAMPLES = fileURLToPath(new URL("../examples/", import.meta.url));
const MAX_ATTEMPTS = 3;

export interface ExtensionAuthoringAttemptReport {
  attempt: number;
  passed: boolean;
  stage: "install" | "discovery" | "activation" | "reload" | "remove" | "complete";
  failure?: string;
}

export interface ExtensionAuthoringTaskReport {
  id: string;
  checks: string[];
  attempts: ExtensionAuthoringAttemptReport[];
  passed: boolean;
  passedAt?: number;
}

export interface ExtensionAuthoringBenchmarkReport {
  schemaVersion: 1;
  suite: "extension-authoring-offline-v1";
  purpose: "extension-authoring-verifier";
  deterministic: true;
  modelCalls: 0;
  maxAttempts: 3;
  tasks: ExtensionAuthoringTaskReport[];
  summary: {
    taskCount: number;
    passed: number;
    passAt1: number;
    passAt3: number;
    attempts: number;
  };
}

interface AuthoringTask {
  id: string;
  checks: string[];
  sources: string[];
  verify(host: RuntimeExtensionHost, resources: ResolvedPaths): void | Promise<void>;
}

function includesAll(actual: readonly string[], expected: readonly string[], label: string): void {
  for (const value of expected) {
    if (!actual.includes(value)) throw new Error(`${label} is missing ${value}`);
  }
}

async function verifyHost(task: AuthoringTask, host: RuntimeExtensionHost, resources: ResolvedPaths): Promise<void> {
  const diagnostics = host.diagnostics();
  if (diagnostics.length > 0) throw new Error(`Runtime activation reported ${diagnostics[0]?.message ?? "a diagnostic"}`);
  await task.verify(host, resources);
}

function directSelection(resources: ResolvedPaths): {
  paths: string[];
  metadata: Map<string, { scope: "user" | "project" | "temporary"; trusted: boolean; resourceRoot?: string }>;
} {
  const selected = resources.extensions.filter((entry) => entry.enabled);
  return {
    paths: selected.map((entry) => entry.path),
    metadata: new Map(selected.map((entry) => [entry.path, {
      scope: entry.metadata.scope,
      trusted: true,
      ...(entry.metadata.baseDir === undefined ? {} : { resourceRoot: entry.metadata.baseDir }),
    }] as const)),
  };
}

async function activateCandidate(candidate: PackageActivationCandidate): Promise<void> {
  const selected = directSelection(candidate.resources);
  const host = await loadDirectExtensions(selected.paths, {
    workspace: candidate.workspace,
    dataRoot: candidate.dataRoot,
    activationFailure: "throw",
    directPathMetadata: selected.metadata,
    ...(candidate.signal === undefined ? {} : { signal: candidate.signal }),
  });
  await host.close();
}

function safeFailure(error: unknown, root: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message
    .replaceAll(root, "<temporary>")
    .replace(/(\.rigyn-package-(?:backup|remove|stage)-)[A-Za-z0-9_-]+/gu, "$1<random>");
  return limitText(normalized, 1_024).text;
}

async function verifyAttempt(
  task: AuthoringTask,
  source: string,
  root: string,
  attempt: number,
): Promise<ExtensionAuthoringAttemptReport> {
  const managed = join(root, "managed", task.id, String(attempt));
  const workspace = join(root, "workspaces", task.id, String(attempt));
  await mkdir(workspace, { recursive: true });
  const settings = SettingsManager.inMemory();
  const manager = new DefaultPackageManager({
    cwd: workspace,
    agentDir: managed,
    settingsManager: settings,
    activateCandidate,
  });
  let stage: ExtensionAuthoringAttemptReport["stage"] = "install";
  let installed = false;
  let firstHost: RuntimeExtensionHost | undefined;
  let secondHost: RuntimeExtensionHost | undefined;
  try {
    await manager.installAndPersist(source);
    installed = true;
    stage = "discovery";
    const resources = await manager.resolve();
    const direct = directSelection(resources);
    if (direct.paths.length === 0) throw new Error("Installed package has no active direct factory");

    stage = "activation";
    firstHost = await loadDirectExtensions(direct.paths, {
      workspace,
      activationFailure: "throw",
      directPathMetadata: direct.metadata,
    });
    await verifyHost(task, firstHost, resources);
    await firstHost.close();
    firstHost = undefined;

    stage = "reload";
    const reloadedResources = await manager.resolve();
    const reloaded = directSelection(reloadedResources);
    if (reloaded.paths.length === 0) throw new Error("Package disappeared during reload discovery");
    secondHost = await loadDirectExtensions(reloaded.paths, {
      workspace,
      activationFailure: "throw",
      directPathMetadata: reloaded.metadata,
    });
    await verifyHost(task, secondHost, reloadedResources);
    await secondHost.close();
    secondHost = undefined;

    stage = "remove";
    await manager.removeAndPersist(source);
    installed = false;
    if (manager.listConfiguredPackages().length !== 0) throw new Error("Package remained configured after removal");
    return { attempt, passed: true, stage: "complete" };
  } catch (error) {
    return { attempt, passed: false, stage, failure: safeFailure(error, root) };
  } finally {
    await firstHost?.close().catch(() => undefined);
    await secondHost?.close().catch(() => undefined);
    if (installed) await manager.removeAndPersist(source).catch(() => undefined);
  }
}

async function corpus(root: string): Promise<AuthoringTask[]> {
  const broken = join(root, "candidates", "missing-runtime");
  await cp(join(EXAMPLES, "starter"), broken, { recursive: true });
  const manifest = JSON.parse(await readFile(join(broken, "package.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(broken, "package.json"), `${JSON.stringify({
    ...manifest,
    rigyn: { extensions: ["extensions/missing.mjs"] },
  }, null, 2)}\n`);

  const starter = join(EXAMPLES, "starter");
  const dynamic = join(EXAMPLES, "dynamic-package");
  return [
    {
      id: "command-package",
      checks: ["managed-install", "public-loader", "command-registration", "reload", "remove"],
      sources: [starter, starter, starter],
      verify(host) {
        includesAll(host.commands().map((entry) => entry.name), ["example-hello"], "command catalog");
      },
    },
    {
      id: "tool-package-after-invalid-attempt",
      checks: ["invalid-attempt-recovery", "managed-install", "tool-registration", "reload", "remove"],
      sources: [broken, starter, starter],
      verify(host) {
        includesAll(host.tools().map((entry) => entry.definition.name), ["example_text_length"], "tool catalog");
      },
    },
    {
      id: "multi-resource-package",
      checks: ["skill", "prompt", "runtime", "reload", "remove"],
      sources: [dynamic, dynamic, dynamic],
      async verify(host, resources) {
        includesAll(host.commands().map((entry) => entry.name), ["example-dynamic-ready"], "command catalog");
        const dynamic = await host.discoverResources("startup");
        if (dynamic.skillPaths.length !== 1
          || dynamic.promptPaths.length !== 1
          || resources.extensions.filter((entry) => entry.enabled).length !== 1) {
          throw new Error("Declarative contribution counts are incomplete");
        }
      },
    },
  ];
}

export async function runExtensionAuthoringBenchmark(): Promise<ExtensionAuthoringBenchmarkReport> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-extension-authoring-"));
  try {
    const tasks: ExtensionAuthoringTaskReport[] = [];
    for (const task of await corpus(root)) {
      const attempts: ExtensionAuthoringAttemptReport[] = [];
      for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
        const report = await verifyAttempt(task, task.sources[index]!, root, index + 1);
        attempts.push(report);
        if (report.passed) break;
      }
      const passedAt = attempts.find((entry) => entry.passed)?.attempt;
      tasks.push({
        id: task.id,
        checks: [...task.checks],
        attempts,
        passed: passedAt !== undefined,
        ...(passedAt === undefined ? {} : { passedAt }),
      });
    }
    const taskCount = tasks.length;
    const passed = tasks.filter((task) => task.passed).length;
    return {
      schemaVersion: 1,
      suite: "extension-authoring-offline-v1",
      purpose: "extension-authoring-verifier",
      deterministic: true,
      modelCalls: 0,
      maxAttempts: 3,
      tasks,
      summary: {
        taskCount,
        passed,
        passAt1: taskCount === 0 ? 0 : tasks.filter((task) => task.passedAt === 1).length / taskCount,
        passAt3: taskCount === 0 ? 0 : tasks.filter((task) => task.passedAt !== undefined && task.passedAt <= 3).length / taskCount,
        attempts: tasks.reduce((sum, task) => sum + task.attempts.length, 0),
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const report = await runExtensionAuthoringBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.summary.passed !== report.summary.taskCount) process.exitCode = 1;
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) await main();
