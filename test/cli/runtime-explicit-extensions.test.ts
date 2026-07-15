import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";
import { resolveExplicitRuntimeExtensions } from "../../src/extensions/explicit-runtime.js";
import { ProjectPackageManager } from "../../src/extensions/project-packages.js";
import { SessionStore } from "../../src/storage/store.js";

async function withRuntimeEnvironment<T>(operation: (paths: {
  root: string;
  workspace: string;
  configHome: string;
  stateHome: string;
}) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "harness-explicit-extensions-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(configHome, "rigyn"), { recursive: true, mode: 0o700 });
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousState = process.env.XDG_STATE_HOME;
  const previousCredentialKey = process.env.RIGYN_CREDENTIAL_KEY;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.RIGYN_CREDENTIAL_KEY = Buffer.alloc(32, 11).toString("base64url");
  try {
    return await operation({ root, workspace, configHome, stateHome });
  } finally {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousCredentialKey === undefined) delete process.env.RIGYN_CREDENTIAL_KEY;
    else process.env.RIGYN_CREDENTIAL_KEY = previousCredentialKey;
    await rm(root, { recursive: true, force: true });
  }
}

function commandExtension(name: string): string {
  return `export default function activate(api) {
    api.registerCommand({ name: ${JSON.stringify(name)}, execute() { return ${JSON.stringify(name)}; } });
  }\n`;
}

async function runCli(args: string[], environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/bin/rigyn.ts", ...args], {
    cwd: resolve("."),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI subprocess timed out"));
    }, 10_000);
    child.once("error", reject);
    child.once("exit", (value) => {
      clearTimeout(timeout);
      resolveExit(value);
    });
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function writeManagedExtension(configHome: string): Promise<string> {
  const root = join(configHome, "rigyn", "extensions", "managed");
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "managed",
    name: "Managed",
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));
  await writeFile(join(root, "runtime", "index.mjs"), commandExtension("managed-command"));
  return root;
}

async function writeDeclarativeExtension(configHome: string): Promise<void> {
  const root = join(configHome, "rigyn", "extensions", "declarative");
  await Promise.all([
    mkdir(join(root, "prompts"), { recursive: true }),
    mkdir(join(root, "commands"), { recursive: true }),
    mkdir(join(root, "skills", "one-shot-skill"), { recursive: true }),
  ]);
  await writeFile(join(root, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "declarative",
    name: "Declarative",
    contributions: {
      skillRoots: [{ path: "skills" }],
      prompts: [{ id: "one-shot-prompt", path: "prompts/review.md" }],
      commands: [{ name: "one-shot-command", path: "commands/review.md" }],
    },
  }));
  await Promise.all([
    writeFile(join(root, "prompts", "review.md"), "Prompt input: {{input}}\n"),
    writeFile(join(root, "commands", "review.md"), "Command args: {{args}}\n"),
    writeFile(join(root, "skills", "one-shot-skill", "SKILL.md"), [
      "---",
      "name: one-shot-skill",
      "description: Exercise one-shot skill loading.",
      "---",
      "Follow the one-shot skill instructions.",
      "",
    ].join("\n")),
  ]);
}

test("explicit runtime extensions are repeatable, ordered after managed entries, and invocation-only", async () => {
  await withRuntimeEnvironment(async ({ root, workspace, configHome }) => {
    const managed = await writeManagedExtension(configHome);
    const first = join(workspace, "first.mjs");
    const firstSkill = join(workspace, "first-skill");
    const secondDirectory = join(root, "absolute-extension");
    await mkdir(firstSkill);
    await writeFile(join(firstSkill, "SKILL.md"), "---\nname: first-invocation-skill\ndescription: Invocation-only skill.\n---\nUse it.\n");
    await writeFile(first, `export default function activate(api) {
      api.registerCommand({ name: "first-command", execute() { return "first-command"; } });
      api.on("resources_discover", () => ({ skillPaths: ["first-skill/SKILL.md"] }));
    }\n`);
    await mkdir(secondDirectory);
    await writeFile(join(secondDirectory, "index.mjs"), commandExtension("second-command"));

    const runtime = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: true,
      extensionPaths: [join(managed, "runtime", "index.mjs"), "first.mjs", secondDirectory],
      extensionRuntime: true,
    });
    try {
      assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), [
        "managed-command",
        "first-command",
        "second-command",
      ]);
      assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.sourcePath), [
        join(managed, "runtime", "index.mjs"),
        first,
        join(secondDirectory, "index.mjs"),
      ]);
      const resources = await runtime.service.resourceCatalog();
      assert.equal(resources.skills.find((entry) => entry.name === "first-invocation-skill")?.scope, "workspace");
      const command = resources.commands.runtimeExtensions.find((entry) => entry.baseName === "first-command");
      assert.equal(command?.scope, "invocation");
      assert.equal(command?.trusted, true);
    } finally {
      await runtime.close();
    }

    const explicitOnly = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: false,
      extensionPaths: ["first.mjs", secondDirectory],
      extensionRuntime: true,
    });
    try {
      assert.deepEqual(explicitOnly.runtimeExtensions.commands().map((entry) => entry.name), [
        "first-command",
        "second-command",
      ]);
    } finally {
      await explicitOnly.close();
    }

    const laterInvocation = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: false,
      extensionRuntime: true,
    });
    try {
      assert.deepEqual(laterInvocation.runtimeExtensions.commands(), []);
      assert.deepEqual(await readdir(join(configHome, "rigyn", "extensions")), ["managed"]);
      const resources = await laterInvocation.service.resourceCatalog();
      assert.equal(resources.skills.some((entry) => entry.name === "first-invocation-skill"), false);
      assert.equal(resources.commands.runtimeExtensions.some((entry) => entry.baseName === "first-command"), false);
    } finally {
      await laterInvocation.close();
    }
  });
});

test("managed root runtime filters cannot be bypassed by legacy automatic discovery", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    const extensionsRoot = join(configHome, "rigyn", "extensions");
    const managedRoot = join(extensionsRoot, "filtered-root");
    await mkdir(managedRoot, { recursive: true });
    await writeFile(join(managedRoot, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "filtered-root",
      name: "Filtered root",
      contributions: { runtime: [{ path: "index.mjs" }] },
    }));
    await writeFile(join(managedRoot, "index.mjs"), commandExtension("filtered-command"));
    await writeFile(join(extensionsRoot, "legacy.mjs"), commandExtension("legacy-command"));
    await writeFile(join(configHome, "rigyn", "config.jsonc"), JSON.stringify({
      packageResources: { "filtered-root": ["runtime:index.mjs"] },
    }));

    const runtime = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: true,
      extensionRuntime: true,
    });
    try {
      assert.deepEqual(runtime.extensions.bundle().runtime, []);
      assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), ["legacy-command"]);
    } finally {
      await runtime.close();
    }
  });
});

test("extensions doctor is dispatched as a bounded CLI command instead of model input", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    await writeManagedExtension(configHome);
    const result = await runCli([
      "extensions",
      "doctor",
      "--json",
      "--offline",
      "--workspace",
      workspace,
    ], { ...process.env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout) as {
      healthy: boolean;
      active: number;
      diagnostics: unknown[];
      runtimeDiagnostics: unknown[];
    };
    assert.equal(report.healthy, true);
    assert.equal(report.active, 1);
    assert.deepEqual(report.diagnostics, []);
    assert.deepEqual(report.runtimeDiagnostics, []);
  });
});

test("extensions commands reports active runtime and declarative commands", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    await Promise.all([
      writeManagedExtension(configHome),
      writeDeclarativeExtension(configHome),
    ]);
    const result = await runCli([
      "extensions",
      "commands",
      "--json",
      "--workspace",
      workspace,
    ], { ...process.env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const catalog = JSON.parse(result.stdout) as {
      runtime: Array<{ name: string; extensionId: string }>;
      templates: Array<{ name: string; extensionId: string; template?: string }>;
    };
    assert.deepEqual(catalog.runtime.map(({ name, extensionId }) => ({ name, extensionId })), [{
      name: "managed-command",
      extensionId: "managed",
    }]);
    assert.deepEqual(catalog.templates.map(({ name, extensionId }) => ({ name, extensionId })), [{
      name: "one-shot-command",
      extensionId: "declarative",
    }]);
    assert.equal(catalog.templates[0]?.template, undefined);
  });
});

test("one-shot print and JSON runs expand an installed runtime command inside the harness", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    await writeManagedExtension(configHome);
    const common = [
      "run",
      "/managed-command ignored arguments",
      "--workspace",
      workspace,
      "--extension",
      resolve("examples/custom-provider/runtime/index.mjs"),
      "--provider",
      "gallery-offline",
      "--model",
      "gallery-offline-v1",
      "--no-session",
    ];
    const printed = await runCli([...common, "--print"], { ...process.env });
    assert.equal(printed.code, 0, printed.stderr);
    assert.equal(printed.stderr, "");
    assert.equal(printed.stdout, "Offline provider: managed-command\n");

    const json = await runCli([...common, "--json"], { ...process.env });
    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stderr, "");
    const events = json.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
      event: { type: string; text?: string };
    });
    assert.equal(
      events.filter(({ event }) => event.type === "text_delta").at(-1)?.event.text,
      "Offline provider: managed-command",
    );
  });
});

test("one-shot run expands installed prompts, commands, and skills inside the harness", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    await writeDeclarativeExtension(configHome);
    const common = [
      "--workspace",
      workspace,
      "--extension",
      resolve("examples/custom-provider/runtime/index.mjs"),
      "--provider",
      "gallery-offline",
      "--model",
      "gallery-offline-v1",
      "--no-session",
      "--print",
    ];
    const prompt = await runCli(["run", "/one-shot-prompt evidence", ...common], { ...process.env });
    assert.equal(prompt.code, 0, prompt.stderr);
    assert.equal(prompt.stderr, "");
    assert.equal(prompt.stdout, "Offline provider: Prompt input: evidence\n");

    const command = await runCli(["run", "/one-shot-command exact args", ...common], { ...process.env });
    assert.equal(command.code, 0, command.stderr);
    assert.equal(command.stderr, "");
    assert.equal(command.stdout, "Offline provider: Command args: exact args\n");

    const skill = await runCli(["run", "/skill:one-shot-skill apply now", ...common], { ...process.env });
    assert.equal(skill.code, 0, skill.stderr);
    assert.equal(skill.stderr, "");
    assert.match(skill.stdout, /Offline provider: <skill name="one-shot-skill"/u);
    assert.match(skill.stdout, /Follow the one-shot skill instructions\./u);
    assert.match(skill.stdout, /apply now/u);
  });
});

test("extensions doctor and show include live runtime activation diagnostics", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    const managed = await writeManagedExtension(configHome);
    await writeFile(join(managed, "runtime", "index.mjs"), "export default 42;\n");

    const doctor = await runCli([
      "extensions",
      "doctor",
      "--json",
      "--offline",
      "--workspace",
      workspace,
    ], { ...process.env });
    assert.equal(doctor.code, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout) as {
      healthy: boolean;
      runtimeDiagnostics: Array<{ extensionId: string; message: string }>;
    };
    assert.equal(report.healthy, false);
    assert.equal(report.runtimeDiagnostics[0]?.extensionId, "managed");
    assert.match(report.runtimeDiagnostics[0]?.message ?? "", /must export a default or named activate function/u);

    const show = await runCli([
      "extensions",
      "show",
      "managed",
      "--json",
      "--offline",
      "--workspace",
      workspace,
    ], { ...process.env });
    assert.equal(show.code, 0, show.stderr);
    const details = JSON.parse(show.stdout) as {
      runtimeDiagnostics: Array<{ extensionId: string; message: string }>;
    };
    assert.equal(details.runtimeDiagnostics[0]?.extensionId, "managed");
    assert.match(details.runtimeDiagnostics[0]?.message ?? "", /must export a default or named activate function/u);
  });
});

test("explicit runtime extension paths are bounded to safe files and deterministic directory indexes", async () => {
  await withRuntimeEnvironment(async ({ root, workspace }) => {
    const canonicalWorkspace = await realpath(workspace);
    const outside = join(root, "outside.mjs");
    const unsupported = join(workspace, "unsupported.txt");
    const emptyDirectory = join(workspace, "empty");
    const indexedDirectory = join(workspace, "indexed");
    const linked = join(workspace, "linked.mjs");
    await writeFile(outside, commandExtension("outside-command"));
    await writeFile(unsupported, commandExtension("unsupported-command"));
    await mkdir(emptyDirectory);
    await mkdir(indexedDirectory);
    await writeFile(join(indexedDirectory, "index.js"), commandExtension("js-command"));
    await writeFile(join(indexedDirectory, "index.mjs"), commandExtension("mjs-command"));
    await symlink(outside, linked);

    await assert.rejects(
      resolveExplicitRuntimeExtensions(["../outside.mjs"], canonicalWorkspace),
      /escapes workspace/u,
    );
    await assert.rejects(
      resolveExplicitRuntimeExtensions(["missing.mjs"], canonicalWorkspace),
      /does not exist/u,
    );
    await assert.rejects(
      resolveExplicitRuntimeExtensions(["unsupported.txt"], canonicalWorkspace),
      /must use \.ts/u,
    );
    await assert.rejects(
      resolveExplicitRuntimeExtensions(["empty"], canonicalWorkspace),
      /has no supported index/u,
    );
    await assert.rejects(
      resolveExplicitRuntimeExtensions(["linked.mjs"], canonicalWorkspace),
      /symbolic link/u,
    );
    const resolved = await resolveExplicitRuntimeExtensions(["indexed", "indexed"], canonicalWorkspace);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.sourcePath, join(canonicalWorkspace, "indexed", "index.js"));
  });
});

test("explicit runtime activation failures remain isolated diagnostics", async () => {
  await withRuntimeEnvironment(async ({ workspace }) => {
    await writeFile(join(workspace, "invalid.mjs"), "export default 42;\n");
    const runtime = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: false,
      extensionPaths: ["invalid.mjs"],
      extensionRuntime: true,
    });
    try {
      assert.deepEqual(runtime.runtimeExtensions.commands(), []);
      assert.match(runtime.runtimeExtensions.diagnostics()[0]?.message ?? "", /must export a default or named activate function/u);
    } finally {
      await runtime.close();
    }
  });
});

test("invocation-only packages load all convention resources and are removed on close", async () => {
  await withRuntimeEnvironment(async ({ workspace }) => {
    const source = join(workspace, "temporary-package");
    await mkdir(join(source, "extensions"), { recursive: true });
    await mkdir(join(source, "prompts"), { recursive: true });
    await mkdir(join(source, "skills", "temporary"), { recursive: true });
    await writeFile(join(source, "extensions", "index.ts"), `
const commandName: string = "temporary-package-command";
export default function activate(api: any) {
  api.registerCommand({ name: commandName, execute() { return "temporary"; } });
}
`);
    await writeFile(join(source, "prompts", "temporary.md"), "Temporary package {{input}}\n");
    await writeFile(join(source, "skills", "temporary", "SKILL.md"), "---\nname: temporary-package-skill\ndescription: Temporary package skill.\n---\nUse it.\n");
    await writeFile(join(source, "package.json"), JSON.stringify({
      name: "temporary-package",
      version: "1.0.0",
      rigyn: {
        hostVersion: ">=0.1.0 <0.2.0",
        extensions: ["extensions"],
        prompts: ["prompts"],
        skills: ["skills"],
      },
    }));

    const runtime = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: false,
      packagePaths: ["temporary-package"],
      extensionRuntime: true,
    });
    const installedRoot = runtime.extensions.list().find((entry) => entry.id === "temporary-package")?.sourceRoot;
    assert.ok(installedRoot);
    assert.ok(runtime.extensions.bundle().prompts.some((entry) => entry.id === "temporary"));
    assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), ["temporary-package-command"]);
    const catalog = await runtime.service.resourceCatalog();
    assert.equal(catalog.packages.find((entry) => entry.id === "temporary-package")?.scope, "invocation");
    assert.equal(catalog.extensions.find((entry) => entry.id === "temporary-package")?.scope, "invocation");
    assert.equal(catalog.skills.find((entry) => entry.name === "temporary-package-skill")?.scope, "workspace");
    await runtime.close();

    await assert.rejects(access(installedRoot), /ENOENT/u);
    await access(source);

    const laterInvocation = await loadRuntime({
      workspace,
      ephemeral: true,
      extensions: false,
      extensionRuntime: true,
    });
    try {
      const laterCatalog = await laterInvocation.service.resourceCatalog();
      assert.equal(laterCatalog.packages.some((entry) => entry.id === "temporary-package"), false);
      assert.equal(laterCatalog.extensions.some((entry) => entry.id === "temporary-package"), false);
      assert.equal(laterCatalog.skills.some((entry) => entry.name === "temporary-package-skill"), false);
    } finally {
      await laterInvocation.close();
    }
  });
});

test("trusted project extension files and index directories load without manifests", async () => {
  await withRuntimeEnvironment(async ({ workspace }) => {
    const root = join(workspace, ".rigyn", "extensions");
    await mkdir(join(root, "directory-extension"), { recursive: true });
    await writeFile(join(root, "file-extension.ts"), commandExtension("file-command"));
    await writeFile(join(root, "directory-extension", "index.mjs"), commandExtension("directory-command"));

    const blocked = await loadRuntime({
      workspace,
      projectTrusted: false,
      ephemeral: true,
      extensions: true,
      extensionRuntime: true,
    });
    try {
      assert.deepEqual(blocked.runtimeExtensions.commands(), []);
    } finally {
      await blocked.close();
    }

    const trusted = await loadRuntime({
      workspace,
      projectTrusted: true,
      ephemeral: true,
      extensions: true,
      extensionRuntime: true,
    });
    try {
      assert.deepEqual(trusted.runtimeExtensions.commands().map((entry) => entry.name), [
        "directory-command",
        "file-command",
      ]);
    } finally {
      await trusted.close();
    }
  });
});

test("trusted runtime startup reconciles only immutable project locks and projects declaration metadata", async () => {
  await withRuntimeEnvironment(async ({ workspace }) => {
    const source = join(workspace, "declared-source");
    await mkdir(join(source, "runtime"), { recursive: true });
    await writeFile(join(source, "extension.json"), JSON.stringify({
      schemaVersion: 1,
      id: "declared-runtime",
      name: "Declared runtime",
      version: "1.0.0",
      contributions: { runtime: [{ path: "runtime/index.mjs" }] },
    }));
    await writeFile(join(source, "runtime", "index.mjs"), commandExtension("locked-command"));
    await mkdir(join(workspace, ".rigyn"), { recursive: true });
    await writeFile(join(workspace, ".rigyn", "packages.json"), JSON.stringify({
      schemaVersion: 1,
      packages: [{ id: "declared-runtime", source: { kind: "local", path: "declared-source" } }],
    }));
    await new ProjectPackageManager({ workspace, projectTrusted: true }).update({ all: true });

    await writeFile(join(source, "runtime", "index.mjs"), commandExtension("moving-source-command"));
    const blocked = await loadRuntime({
      workspace,
      projectTrusted: false,
      ephemeral: true,
      extensions: true,
      extensionRuntime: true,
    });
    try {
      assert.equal(blocked.runtimeExtensions.commands().some((entry) => entry.name === "locked-command"), false);
    } finally {
      await blocked.close();
    }

    const runtime = await loadRuntime({
      workspace,
      projectTrusted: true,
      ephemeral: true,
      extensions: true,
      extensionRuntime: true,
    });
    try {
      assert.equal(runtime.runtimeExtensions.commands().some((entry) => entry.name === "locked-command"), true);
      assert.equal(runtime.runtimeExtensions.commands().some((entry) => entry.name === "moving-source-command"), false);
      const packageMetadata = (await runtime.service.resourceCatalog()).packages.find((entry) => entry.id === "declared-runtime");
      assert.deepEqual(packageMetadata?.project?.source, { kind: "local", path: "declared-source" });
      assert.equal(packageMetadata?.project?.resolved.kind, "local");
    } finally {
      await runtime.close();
    }
  });
});

test("run loads an explicit relative extension with automatic discovery disabled and never installs it", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    await writeFile(join(workspace, "offline.mjs"), `export default function activate(api) {
      api.registerProvider({
        id: "explicit-offline",
        async *stream(request) {
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text: "explicit invocation worked" };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() {
          const observedAt = "2026-01-01T00:00:00.000Z";
          const supported = { value: "supported", source: "provider", observedAt };
          const unsupported = { value: "unsupported", source: "provider", observedAt };
          return [{
            id: "explicit-model",
            provider: "explicit-offline",
            capabilities: { tools: supported, reasoning: unsupported, images: unsupported },
          }];
        },
      });
    }\n`);
    const environment = { ...process.env };
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
      delete environment[name];
    }
    const first = await runCli([
      "test explicit loading",
      "--provider", "explicit-offline",
      "--model", "explicit-model",
      "--extension", "offline.mjs",
      "--no-extensions",
      "--no-session",
      "--workspace", workspace,
      "--print",
    ], environment);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, "explicit invocation worked\n");
    await assert.rejects(readdir(join(configHome, "rigyn", "extensions")), /ENOENT/u);

    const json = await runCli([
      "test JSON output",
      "--provider", "explicit-offline",
      "--model", "explicit-model",
      "--extension", "offline.mjs",
      "--no-extensions",
      "--no-session",
      "--workspace", workspace,
      "--mode", "json",
      "--print",
    ], environment);
    assert.equal(json.code, 0, json.stderr);
    const events = json.stdout.trim().split("\n").map((line) => JSON.parse(line) as { event?: { type?: string } });
    assert.ok(events.some((event) => event.event?.type === "run_completed"));

    const models = await runCli([
      "--extension", "offline.mjs",
      "--no-extensions",
      "--workspace", workspace,
      "--list-models", "explicit-model",
    ], environment);
    assert.equal(models.code, 0, models.stderr);
    assert.match(models.stdout, /^explicit-offline\/explicit-model/mu);

    await writeFile(join(workspace, "offline.mjs"), `export default function activate(api) {
      api.registerProvider({
        id: "explicit-offline",
        async *stream() { throw new Error("unused"); },
        async listModels() { throw new Error("live catalog unavailable"); },
      });
    }\n`);
    const unavailable = await runCli([
      "--extension", "offline.mjs",
      "--no-extensions",
      "--workspace", workspace,
      "--list-models", "explicit-model",
    ], environment);
    assert.equal(unavailable.code, 0, unavailable.stderr);
    assert.match(unavailable.stdout, /^No matching models from available providers\./mu);

    const cached = await runCli([
      "--extension", "offline.mjs",
      "--no-extensions",
      "--workspace", workspace,
      "--list-models", "explicit-model",
      "--offline",
    ], environment);
    assert.equal(cached.code, 0, cached.stderr);
    assert.match(cached.stdout, /^explicit-offline\/explicit-model/mu);

    const second = await runCli([
      "test no persistence",
      "--provider", "explicit-offline",
      "--model", "explicit-model",
      "--no-extensions",
      "--no-session",
      "--workspace", workspace,
      "--print",
    ], environment);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /Provider adapter is not registered: explicit-offline/u);
  });
});

test("print positional messages run as sequential stored turns and emit only the final response", async () => {
  await withRuntimeEnvironment(async ({ workspace, stateHome }) => {
    const extension = join(workspace, "sequential.mjs");
    await writeFile(extension, `export default function activate(api) {
      api.registerProvider({
        id: "sequential-offline",
        async *stream(request) {
          const users = request.messages.filter((message) => message.role === "user");
          const last = users.at(-1)?.content.filter((block) => block.type === "text").map((block) => block.text).join("\\n") || "";
          const reply = "reply:" + users.length + ":" + last;
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text: reply };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: reply } } };
        },
        async listModels() { return [{ id: "sequential-model", provider: "sequential-offline" }]; },
      });
    }\n`);
    const result = await runCli([
      "first turn",
      "second turn",
      "--provider", "sequential-offline",
      "--model", "sequential-model",
      "--extension", extension,
      "--no-extensions",
      "--workspace", workspace,
      "--print",
    ], process.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "reply:2:second turn\n");

    const store = new SessionStore(join(stateHome, "rigyn", "sessions.sqlite"));
    try {
      const [thread] = store.listThreads({ workspaceRoot: workspace });
      assert.ok(thread);
      const users = store.listEvents(thread.threadId).flatMap((entry) => {
        if (entry.event.type !== "message_appended" || entry.event.message.role !== "user") return [];
        return [entry.event.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")];
      });
      assert.deepEqual(users, ["first turn", "second turn"]);
    } finally {
      store.close();
    }
  });
});

test("one-shot runs constrain configured thinking to the selected model", async () => {
  await withRuntimeEnvironment(async ({ workspace, configHome }) => {
    await writeFile(join(configHome, "rigyn", "config.jsonc"), JSON.stringify({ thinking: "medium" }));
    await writeFile(join(workspace, "thinking.mjs"), `export default function activate(api) {
      const observedAt = "2026-01-01T00:00:00.000Z";
      const unknown = { value: "unknown", source: "provider", observedAt };
      api.registerProvider({
        id: "thinking-offline",
        async *stream(request) {
          yield { type: "response_start", model: request.model };
          yield { type: "text_delta", part: 0, text: "thinking:" + (request.reasoningEffort ?? "off") };
          yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant" } } };
        },
        async listModels() {
          return [{
            id: "plain-model",
            provider: "thinking-offline",
            capabilities: { tools: unknown, reasoning: { value: "unsupported", source: "provider", observedAt }, images: unknown },
          }];
        },
      });
    }\n`);
    const environment = { ...process.env };
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
      delete environment[name];
    }
    const result = await runCli([
      "check model thinking",
      "--provider", "thinking-offline",
      "--model", "plain-model",
      "--extension", "thinking.mjs",
      "--no-extensions",
      "--no-session",
      "--workspace", workspace,
      "--print",
    ], environment);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "thinking:off\n");
    assert.match(result.stderr, /does not support configured thinking level medium; using off/u);
  });
});

test("rpc exposes commands from an explicit invocation-scoped extension", async () => {
  await withRuntimeEnvironment(async ({ workspace }) => {
    await writeFile(join(workspace, "rpc-extension.mjs"), commandExtension("rpc-explicit"));
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/bin/rigyn.ts",
      "rpc",
      "--workspace", workspace,
      "--extension", "rpc-extension.mjs",
      "--no-extensions",
    ], {
      cwd: resolve("."),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.stdin.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "extension.command.list" }),
    ].join("\n") + "\n");
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("RPC subprocess timed out"));
      }, 10_000);
      child.once("error", reject);
      child.once("exit", (value) => {
        clearTimeout(timeout);
        resolveExit(value);
      });
    });
    assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
    const messages = Buffer.concat(stdout).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      id: number;
      result?: Array<{ name: string }>;
    });
    assert.deepEqual(messages.find((message) => message.id === 2)?.result?.map((entry) => entry.name), ["rpc-explicit"]);
  });
});
