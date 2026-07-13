import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  discoverExtensions,
  loadRuntimeExtensions,
  LocalExtensionPackageManager,
  type ExtensionMetadata,
  type RuntimeExtensionHost,
} from "../src/extensions/index.js";
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
  verify(host: RuntimeExtensionHost, metadata: ExtensionMetadata): void;
}

function includesAll(actual: readonly string[], expected: readonly string[], label: string): void {
  for (const value of expected) {
    if (!actual.includes(value)) throw new Error(`${label} is missing ${value}`);
  }
}

function verifyHost(task: AuthoringTask, host: RuntimeExtensionHost, metadata: ExtensionMetadata): void {
  const diagnostics = host.diagnostics();
  if (diagnostics.length > 0) throw new Error(`Runtime activation reported ${diagnostics[0]?.message ?? "a diagnostic"}`);
  task.verify(host, metadata);
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
  const manager = new LocalExtensionPackageManager({ user: managed });
  let stage: ExtensionAuthoringAttemptReport["stage"] = "install";
  let packageId: string | undefined;
  let firstHost: RuntimeExtensionHost | undefined;
  let secondHost: RuntimeExtensionHost | undefined;
  try {
    const installed = await manager.install(source);
    packageId = installed.id;
    stage = "discovery";
    const catalog = await discoverExtensions(manager.sources(false));
    const metadata = catalog.list().find((entry) => entry.id === installed.id);
    if (metadata === undefined || metadata.status !== "active" || !catalog.doctor().healthy) {
      throw new Error(catalog.doctor().diagnostics[0]?.message ?? "Installed package is not active and healthy");
    }

    stage = "activation";
    firstHost = await loadRuntimeExtensions(catalog.bundle().runtime, { workspace });
    verifyHost(task, firstHost, metadata);
    await firstHost.close();
    firstHost = undefined;

    stage = "reload";
    const reloadedCatalog = await discoverExtensions(manager.sources(false));
    const reloadedMetadata = reloadedCatalog.list().find((entry) => entry.id === installed.id);
    if (reloadedMetadata === undefined || reloadedMetadata.status !== "active") {
      throw new Error("Package disappeared during reload discovery");
    }
    secondHost = await loadRuntimeExtensions(reloadedCatalog.bundle().runtime, { workspace });
    verifyHost(task, secondHost, reloadedMetadata);
    await secondHost.close();
    secondHost = undefined;

    stage = "remove";
    await manager.remove(installed.id);
    packageId = undefined;
    if ((await manager.list("user")).length !== 0) throw new Error("Package remained installed after removal");
    return { attempt, passed: true, stage: "complete" };
  } catch (error) {
    return { attempt, passed: false, stage, failure: safeFailure(error, root) };
  } finally {
    await firstHost?.close().catch(() => undefined);
    await secondHost?.close().catch(() => undefined);
    if (packageId !== undefined) await manager.remove(packageId).catch(() => undefined);
  }
}

async function corpus(root: string): Promise<AuthoringTask[]> {
  const broken = join(root, "candidates", "missing-runtime");
  await cp(join(EXAMPLES, "custom-tool"), broken, { recursive: true });
  const manifest = JSON.parse(await readFile(join(broken, "extension.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(broken, "extension.json"), `${JSON.stringify({
    ...manifest,
    contributions: { runtime: [{ path: "runtime/missing.mjs" }] },
  }, null, 2)}\n`);

  const starter = join(EXAMPLES, "package-starter");
  const customTool = join(EXAMPLES, "custom-tool");
  const reference = join(EXAMPLES, "reference-package");
  return [
    {
      id: "command-package",
      checks: ["managed-install", "public-loader", "command-registration", "reload", "remove"],
      sources: [starter, starter, starter],
      verify(host) {
        includesAll(host.commands().map((entry) => entry.name), ["starter-review"], "command catalog");
      },
    },
    {
      id: "tool-package-after-invalid-attempt",
      checks: ["invalid-attempt-recovery", "managed-install", "tool-registration", "reload", "remove"],
      sources: [broken, customTool, customTool],
      verify(host) {
        includesAll(host.tools().map((entry) => entry.definition.name), ["text_metrics"], "tool catalog");
      },
    },
    {
      id: "multi-resource-package",
      checks: ["skill", "prompt", "theme", "runtime", "reload", "remove"],
      sources: [reference, reference, reference],
      verify(host, metadata) {
        includesAll(host.tools().map((entry) => entry.definition.name), ["reference_echo"], "tool catalog");
        includesAll(host.commands().map((entry) => entry.name), ["reference-demo"], "command catalog");
        if (metadata.contributions.skillRoots !== 1 || metadata.contributions.prompts !== 1
          || metadata.contributions.themes !== 1 || metadata.contributions.runtime !== 1) {
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
