import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

import {
  discoverProjectTrustResources,
  ProjectTrustResolver,
} from "../../src/cli/project-trust.js";
import { loadRuntime, preactivateProjectTrustExtensions } from "../../src/cli/runtime.js";
import { TrustStore } from "../../src/config/trust.js";
import type { InlineExtension } from "../../src/extensions/direct.js";
import type { TerminalChoice, TerminalPrompter } from "../../src/interfaces/terminal.js";
import { sha256 } from "../../src/tools/hash.js";
import { loadTestDirectExtensions } from "../helpers/direct-extension-loader.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeSourceUrl = pathToFileURL(join(packageRoot, "src", "cli", "runtime.ts")).href;
const cliSourcePath = join(packageRoot, "src", "bin", "rigyn.ts");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

class SelectingTerminal implements TerminalPrompter {
  readonly prompts: string[] = [];
  readonly choiceLabels: string[][] = [];
  readonly #label: RegExp;

  constructor(label: RegExp) {
    this.#label = label;
  }

  async question(): Promise<string> {
    throw new Error("Project trust must use a bounded choice");
  }

  async choose<T>(prompt: string, choices: TerminalChoice<T>[]): Promise<T> {
    this.prompts.push(prompt);
    this.choiceLabels.push(choices.map((choice) => choice.label));
    const selected = choices.find((choice) => this.#label.test(choice.label));
    if (selected === undefined) throw new Error(`Missing test choice matching ${this.#label}`);
    return selected.value;
  }
}

async function fixture(context: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), name));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "projects", "workspace");
  await mkdir(workspace, { recursive: true });
  return {
    root,
    workspace,
    store: new TrustStore(join(root, "state", "trust.json")),
  };
}

async function trustExtensionHost(workspace: string, root: string, source: string) {
  const path = join(root, `trust-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(path, source);
  return await loadTestDirectExtensions([{
    extensionId: "trust-policy",
    sourcePath: path,
    sha256: sha256(source),
    scope: "user",
    trusted: true,
  }], { workspace });
}

test("clean projects and empty resource directories never prompt", async (context) => {
  const value = await fixture(context, "harness-project-trust-clean-");
  await mkdir(join(value.workspace, ".rigyn", "extensions"), { recursive: true });
  await mkdir(join(value.workspace, ".agents", "skills"), { recursive: true });
  const terminal = new SelectingTerminal(/Enable this workspace/u);
  const resolver = new ProjectTrustResolver(value.store, { terminal });

  assert.deepEqual(await discoverProjectTrustResources(value.workspace), []);
  assert.equal(await resolver.isTrusted(value.workspace), false);
  assert.deepEqual(terminal.prompts, []);
});

test("resource discovery is metadata-only and covers settings, package declarations, prompts, extensions, and compatible skills", async (context) => {
  const value = await fixture(context, "harness-project-trust-discovery-");
  await mkdir(join(value.workspace, ".rigyn", "extensions", "demo"), { recursive: true });
  await mkdir(join(value.workspace, ".rigyn", "packages", "managed"), { recursive: true });
  await mkdir(join(value.workspace, ".rigyn", "skills", "local"), { recursive: true });
  await mkdir(join(value.workspace, ".rigyn", "prompts"), { recursive: true });
  await mkdir(join(value.workspace, ".rigyn", "themes"), { recursive: true });
  await mkdir(join(value.workspace, ".agents", "skills", "compatible"), { recursive: true });
  await mkdir(join(value.workspace, ".claude", "skills", "compatible"), { recursive: true });
  await mkdir(join(value.workspace, ".codex", "skills", "compatible"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "not parsed during discovery");
  await writeFile(join(value.workspace, ".rigyn", "packages.json"), "not parsed during discovery");
  await writeFile(join(value.workspace, ".rigyn", "packages.lock.json"), "not parsed during discovery");
  await writeFile(join(value.workspace, ".rigyn", "SYSTEM.md"), "not read during discovery");
  await writeFile(join(value.workspace, ".rigyn", "extensions", "demo", "package.json"), "{}");
  await writeFile(join(value.workspace, ".rigyn", "skills", "local", "SKILL.md"), "local");
  await writeFile(join(value.workspace, ".rigyn", "prompts", "review.md"), "review");
  await writeFile(join(value.workspace, ".rigyn", "themes", "ocean.json"), "{}");
  await writeFile(join(value.workspace, ".agents", "skills", "compatible", "SKILL.md"), "compatible");
  await writeFile(join(value.workspace, ".claude", "skills", "compatible", "SKILL.md"), "compatible");
  await writeFile(join(value.workspace, ".codex", "skills", "compatible", "SKILL.md"), "compatible");

  assert.deepEqual(await discoverProjectTrustResources(value.workspace), [
    ".rigyn/settings.json",
    ".rigyn/packages.json",
    ".rigyn/packages.lock.json",
    ".rigyn/SYSTEM.md",
    ".rigyn/extensions",
    ".rigyn/packages",
    ".rigyn/skills",
    ".rigyn/prompts",
    ".rigyn/themes",
    ".agents/skills",
    ".claude/skills",
    ".codex/skills",
  ]);
});

test("workspace approval persists once and revocation is rechecked without a second prompt", async (context) => {
  const value = await fixture(context, "harness-project-trust-workspace-");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "{}");
  const terminal = new SelectingTerminal(/Enable this workspace/u);
  const resolver = new ProjectTrustResolver(value.store, { terminal });

  assert.equal(await resolver.isTrusted(value.workspace), true);
  assert.equal(await value.store.isTrusted(value.workspace), true);
  assert.equal(await resolver.isTrusted(value.workspace), true);
  assert.equal(terminal.prompts.length, 1);

  await value.store.untrust(value.workspace);
  assert.equal(await resolver.isTrusted(value.workspace), false);
  assert.equal(terminal.prompts.length, 1);
});

test("persistent decline survives a new resolver while launch-only choices remain process-local", async (context) => {
  const value = await fixture(context, "harness-project-trust-decline-");
  await mkdir(join(value.workspace, ".rigyn", "extensions", "demo"), { recursive: true });
  const persistentTerminal = new SelectingTerminal(/Keep disabled for this workspace/u);
  const persistent = new ProjectTrustResolver(value.store, { terminal: persistentTerminal });

  assert.equal(await persistent.isTrusted(value.workspace), false);
  assert.equal(await value.store.decision(value.workspace), false);
  const restartedTerminal = new SelectingTerminal(/Enable this workspace/u);
  const restarted = new ProjectTrustResolver(value.store, { terminal: restartedTerminal });
  assert.equal(await restarted.isTrusted(value.workspace), false);
  assert.deepEqual(restartedTerminal.prompts, []);

  await value.store.untrust(value.workspace);
  const launchTerminal = new SelectingTerminal(/Keep disabled for this launch/u);
  const launch = new ProjectTrustResolver(value.store, { terminal: launchTerminal });
  assert.equal(await launch.isTrusted(value.workspace), false);
  assert.equal(await launch.isTrusted(value.workspace), false);
  assert.equal(await value.store.decision(value.workspace), undefined);
  assert.equal(launchTerminal.prompts.length, 1);

  const trustLaunchTerminal = new SelectingTerminal(/Enable for this launch/u);
  const trustLaunch = new ProjectTrustResolver(value.store, { terminal: trustLaunchTerminal });
  assert.equal(await trustLaunch.isTrusted(value.workspace), true);
  assert.equal(await trustLaunch.isTrusted(value.workspace), true);
  assert.equal(await value.store.isTrusted(value.workspace), false);
  assert.equal(trustLaunchTerminal.prompts.length, 1);
  assert.deepEqual(trustLaunchTerminal.choiceLabels[0], [
    "Enable this workspace",
    "Enable the parent directory",
    "Enable for this launch",
    "Keep disabled for this workspace",
    "Keep disabled for this launch",
  ]);
});

test("prompt- or theme-only projects request a trust decision", async (context) => {
  const value = await fixture(context, "harness-project-trust-presentation-");
  await mkdir(join(value.workspace, ".rigyn", "prompts"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "prompts", "review.md"), "review");
  const terminal = new SelectingTerminal(/Keep disabled for this launch/u);
  assert.equal(await new ProjectTrustResolver(value.store, { terminal }).isTrusted(value.workspace), false);
  assert.equal(terminal.prompts.length, 1);

  await rm(join(value.workspace, ".rigyn", "prompts"), { recursive: true, force: true });
  await mkdir(join(value.workspace, ".rigyn", "themes"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "themes", "ocean.json"), "{}");
  const themeTerminal = new SelectingTerminal(/Keep disabled for this launch/u);
  assert.equal(await new ProjectTrustResolver(value.store, { terminal: themeTerminal }).isTrusted(value.workspace), false);
  assert.equal(themeTerminal.prompts.length, 1);
});

test("default project trust is validated by the resolver without persisting an implicit decision", async (context) => {
  const value = await fixture(context, "harness-project-trust-default-");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "{}");

  const always = new ProjectTrustResolver(value.store, { defaultProjectTrust: "always" });
  assert.equal(await always.isTrusted(value.workspace), true);
  assert.equal(await always.isTrusted(value.workspace), true);
  assert.equal(await value.store.decision(value.workspace), undefined);

  const neverTerminal = new SelectingTerminal(/Enable this workspace/u);
  const never = new ProjectTrustResolver(value.store, { defaultProjectTrust: "never", terminal: neverTerminal });
  assert.equal(await never.isTrusted(value.workspace), false);
  assert.deepEqual(neverTerminal.prompts, []);
  assert.equal(await value.store.decision(value.workspace), undefined);
});

test("parent approval is explicit and inherited only below the selected parent", async (context) => {
  const value = await fixture(context, "harness-project-trust-parent-");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "APPEND_SYSTEM.md"), "trusted later");
  const terminal = new SelectingTerminal(/Enable the parent directory/u);
  const resolver = new ProjectTrustResolver(value.store, { terminal });

  assert.equal(await resolver.isTrusted(value.workspace), true);
  assert.deepEqual((await value.store.list()).map(({ workspace, descendants }) => ({ workspace, descendants })), [{
    workspace: resolve(value.workspace, ".."),
    descendants: true,
  }]);
  const another = join(value.root, "projects", "another");
  const outside = join(value.root, "outside");
  await mkdir(another);
  await mkdir(outside);
  assert.equal(await value.store.isTrusted(another), true);
  assert.equal(await value.store.isTrusted(outside), false);
});

test("one-run overrides are deterministic and never modify persisted trust", async (context) => {
  const value = await fixture(context, "harness-project-trust-override-");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "{}");
  const terminal = new SelectingTerminal(/missing choice/u);

  const approved = new ProjectTrustResolver(value.store, { terminal, override: "approve" });
  assert.equal(await approved.isTrusted(value.workspace), true);
  assert.equal(await value.store.isTrusted(value.workspace), false);

  await value.store.trust(value.workspace);
  const denied = new ProjectTrustResolver(value.store, { terminal, override: "deny" });
  assert.equal(await denied.isTrusted(value.workspace), false);
  assert.equal(await value.store.isTrusted(value.workspace), true);
  assert.deepEqual(terminal.prompts, []);
});

test("extension decisions precede saved policy and persist only exact workspaces when requested", async (context) => {
  const value = await fixture(context, "rigyn-project-trust-extension-policy-");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "{}");
  await value.store.deny(value.workspace);
  let activations = 0;
  const launch = new ProjectTrustResolver(value.store, {
    preactivate: async (workspace) => {
      activations += 1;
      return await trustExtensionHost(workspace, value.root, `export default (api) => api.on("project_trust", () => ({ trusted: "yes" }));\n`);
    },
  });
  assert.equal(await launch.isTrusted(value.workspace), true);
  assert.equal(await launch.isTrusted(value.workspace), true);
  assert.equal(activations, 1);
  assert.equal(await value.store.decision(value.workspace), false);
  await (await launch.takePreactivatedExtensions(value.workspace))?.close();

  const remembered = new ProjectTrustResolver(value.store, {
    preactivate: async (workspace) => await trustExtensionHost(
      workspace,
      value.root,
      `export default (api) => api.on("project_trust", () => ({ trusted: "yes", remember: true }));\n`,
    ),
  });
  assert.equal(await remembered.isTrusted(value.workspace), true);
  assert.deepEqual((await value.store.listDecisions()).map(({ workspace, descendants, decision }) => ({ workspace, descendants: descendants === true, decision })), [{
    workspace: resolve(value.workspace),
    descendants: false,
    decision: true,
  }]);
  await (await remembered.takePreactivatedExtensions(value.workspace))?.close();
});

test("overrides and workspaces without protected resources suppress extension trust activation", async (context) => {
  const value = await fixture(context, "rigyn-project-trust-extension-suppression-");
  let activations = 0;
  const preactivate = async (): Promise<undefined> => {
    activations += 1;
    return undefined;
  };
  assert.equal(await new ProjectTrustResolver(value.store, { preactivate }).isTrusted(value.workspace), false);
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "{}");
  assert.equal(await new ProjectTrustResolver(value.store, { override: "approve", preactivate }).isTrusted(value.workspace), true);
  assert.equal(await new ProjectTrustResolver(value.store, { override: "deny", preactivate }).isTrusted(value.workspace), false);
  assert.equal(activations, 0);
});

test("project trust events run once per target workspace and retain the launch cwd", async (context) => {
  const value = await fixture(context, "rigyn-project-trust-extension-switch-");
  const second = join(value.root, "projects", "second");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await mkdir(join(second, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "{}");
  await writeFile(join(second, ".rigyn", "settings.json"), "{}");
  const seen: Array<{ workspace: string; cwd: string }> = [];
  const resolver = new ProjectTrustResolver(value.store, {
    cwd: value.root,
    preactivate: async (workspace) => await trustExtensionHost(workspace, value.root, `export default (api) => api.on("project_trust", (event, context) => {
      globalThis.__rigynTrustSwitchEvents = [...(globalThis.__rigynTrustSwitchEvents ?? []), { workspace: event.cwd, cwd: context.cwd }];
      return { trusted: "yes" };
    });\n`),
  });
  for (const workspace of [value.workspace, second]) {
    assert.equal(await resolver.isTrusted(workspace), true);
    const host = await resolver.takePreactivatedExtensions(workspace);
    assert.notEqual(host, undefined);
    seen.push(...((globalThis as Record<string, any>).__rigynTrustSwitchEvents ?? []));
    (globalThis as Record<string, any>).__rigynTrustSwitchEvents = [];
    await host!.close();
  }
  assert.deepEqual(seen, [
    { workspace: resolve(value.workspace), cwd: resolve(value.root) },
    { workspace: resolve(second), cwd: resolve(value.root) },
  ]);
  delete (globalThis as Record<string, unknown>).__rigynTrustSwitchEvents;
});

test("pre-trust user extensions are handed off once and project extensions append after approval", async (context) => {
  const value = await fixture(context, "rigyn-project-trust-handoff-");
  const agentDirectory = join(value.root, "agent");
  const userRoot = join(agentDirectory, "extensions", "trust-owner");
  const projectRoot = join(value.workspace, ".rigyn", "extensions", "project-owner");
  await mkdir(userRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  const manifest = (name: string) => JSON.stringify({ name, rigyn: { extensions: ["index.mjs"] } });
  await writeFile(join(userRoot, "package.json"), manifest("trust-owner"));
  await writeFile(join(userRoot, "index.mjs"), `export default (api) => {
    globalThis.__rigynTrustOwnerActivations = (globalThis.__rigynTrustOwnerActivations ?? 0) + 1;
    api.on("project_trust", () => ({ trusted: "yes" }));
    api.registerCommand("user-trust-command", { handler() {} });
  };\n`);
  await writeFile(join(projectRoot, "package.json"), manifest("project-owner"));
  await writeFile(join(projectRoot, "index.mjs"), `export default (api) => {
    api.registerCommand("project-trust-command", { handler() {} });
  };\n`);
  const priorAgentDirectory = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDirectory;
  try {
    const resolver = new ProjectTrustResolver(
      new TrustStore(join(agentDirectory, "trusted-workspaces.json")),
      {
        preactivate: async (workspace) => await preactivateProjectTrustExtensions({
          userExtensions: join(agentDirectory, "extensions"),
          agentDirectory,
        }, workspace, { extensions: true, extensionRuntime: true }),
      },
    );
    const trusted = await resolver.isTrusted(value.workspace);
    const preactivatedRuntimeExtensions = await resolver.takePreactivatedExtensions(value.workspace);
    assert.equal(trusted, true);
    assert.notEqual(preactivatedRuntimeExtensions, undefined);
    if (preactivatedRuntimeExtensions === undefined) throw new Error("Pre-trust extension host was not retained");
    const runtime = await loadRuntime({
      workspace: value.workspace,
      projectTrusted: trusted,
      extensions: true,
      extensionRuntime: true,
      ephemeral: true,
      preactivatedRuntimeExtensions,
    });
    try {
      assert.equal((globalThis as Record<string, unknown>).__rigynTrustOwnerActivations, 1);
      assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), [
        "project-trust-command",
        "user-trust-command",
      ]);
    } finally {
      await runtime.close();
    }
  } finally {
    if (priorAgentDirectory === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = priorAgentDirectory;
    delete (globalThis as Record<string, unknown>).__rigynTrustOwnerActivations;
  }
});

test("one resolver carries factory trust and preactivated hosts across runtime workspace replacements", async (context) => {
  const value = await fixture(context, "rigyn-project-trust-runtime-switch-");
  const second = join(value.root, "projects", "second");
  const agentDirectory = join(value.root, "agent");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await mkdir(join(second, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "{}\n");
  await writeFile(join(second, ".rigyn", "settings.json"), "{}\n");
  const seen: string[] = [];
  const extension: InlineExtension = {
    name: "runtime-switch-trust",
    factory(api) {
      api.on("project_trust", (event) => {
        seen.push(event.cwd);
        return { trusted: "yes" };
      });
      api.registerCommand("runtime-switch-ready", { async handler() {} });
    },
  };
  const priorAgentDirectory = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = agentDirectory;
  const resolver = new ProjectTrustResolver(new TrustStore(join(agentDirectory, "trusted-workspaces.json")), {
    preactivate: async (workspace) => await preactivateProjectTrustExtensions({
      userExtensions: join(agentDirectory, "extensions"),
      agentDirectory,
    }, workspace, {
      extensions: false,
      extensionFactories: [extension],
      extensionRuntime: true,
    }),
  });
  try {
    for (const workspace of [value.workspace, second]) {
      const runtime = await loadRuntime({
        workspace,
        ephemeral: true,
        extensions: false,
        extensionFactories: [extension],
        extensionRuntime: true,
        projectTrustResolver: resolver,
      });
      try {
        assert.equal(runtime.trusted, true);
        assert.deepEqual(runtime.runtimeExtensions.commands().map((entry) => entry.name), ["runtime-switch-ready"]);
      } finally {
        await runtime.close();
      }
    }
    assert.deepEqual(seen, [resolve(value.workspace), resolve(second)]);
  } finally {
    await resolver.close();
    if (priorAgentDirectory === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = priorAgentDirectory;
  }
});

test("trusted runtimes discover native and compatible project skill roots only after approval", async (context) => {
  const value = await fixture(context, "harness-project-trust-skills-");
  const native = join(value.workspace, ".rigyn", "skills", "native");
  const compatible = join(value.workspace, ".agents", "skills", "compatible");
  const claude = join(value.workspace, ".claude", "skills", "claude-compatible");
  const codex = join(value.workspace, ".codex", "skills", "codex-compatible");
  await mkdir(native, { recursive: true });
  await mkdir(compatible, { recursive: true });
  await mkdir(claude, { recursive: true });
  await mkdir(codex, { recursive: true });
  await writeFile(join(native, "SKILL.md"), "---\nname: native\ndescription: Native project skill\n---\nNative instructions.\n");
  await writeFile(join(compatible, "SKILL.md"), "---\nname: compatible\ndescription: Compatible project skill\n---\nCompatible instructions.\n");
  await writeFile(join(claude, "SKILL.md"), "---\nname: claude-compatible\ndescription: Claude-compatible project skill\n---\nClaude-compatible instructions.\n");
  await writeFile(join(codex, "SKILL.md"), "---\nname: codex-compatible\ndescription: Codex-compatible project skill\n---\nCodex-compatible instructions.\n");

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RIGYN_CODING_AGENT_DIR: join(value.root, "agent"),
    XDG_STATE_HOME: join(value.root, "runtime-state"),
  };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  const inspect = async (projectTrusted: boolean): Promise<string[]> => {
    const output = join(value.root, `skills-${projectTrusted}.json`);
    const script = `
      import { writeFile } from "node:fs/promises";
      import { loadRuntime } from ${JSON.stringify(runtimeSourceUrl)};
      const runtime = await loadRuntime({ workspace: ${JSON.stringify(value.workspace)}, projectTrusted: ${projectTrusted}, ephemeral: true });
      try { await writeFile(${JSON.stringify(output)}, JSON.stringify(runtime.resourceLoader.getSkills().skills.map((skill) => skill.name).sort())); }
      finally { await runtime.close(); }
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: packageRoot,
      env: environment,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(await readFile(output, "utf8")) as string[];
  };

  const untrusted = await inspect(false);
  assert.equal(untrusted.includes("compatible"), false);
  assert.equal(untrusted.includes("native"), false);
  assert.equal(untrusted.includes("claude-compatible"), false);
  assert.equal(untrusted.includes("codex-compatible"), false);
  const trusted = await inspect(true);
  assert.equal(trusted.includes("compatible"), true);
  assert.equal(trusted.includes("native"), true);
  assert.equal(trusted.includes("claude-compatible"), true);
  assert.equal(trusted.includes("codex-compatible"), true);
  assert.equal(await value.store.isTrusted(value.workspace), false);
});

test("CLI trust and fork flags enforce conflicts while noninteractive overrides stay invocation-only", async (context) => {
  const value = await fixture(context, "harness-project-trust-cli-");
  const agentDirectory = join(value.root, "agent");
  const stateHome = join(value.root, "runtime-state");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "{ invalid project settings");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RIGYN_CODING_AGENT_DIR: agentDirectory,
    XDG_STATE_HOME: stateHome,
    NO_COLOR: "1",
  };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  const run = (argumentsValue: string[]) => spawnSync(process.execPath, [
    "--import", "tsx", cliSourcePath,
    ...argumentsValue,
  ], { cwd: packageRoot, env: environment, encoding: "utf8" });

  const trustConflict = run(["--workspace", value.workspace, "--approve", "--no-approve", "hello"]);
  assert.notEqual(trustConflict.status, 0);
  assert.match(trustConflict.stderr, /--approve and --no-approve are mutually exclusive/u);

  const ephemeralFork = run(["--workspace", value.workspace, "--no-session", "--fork", "source", "hello"]);
  assert.notEqual(ephemeralFork.status, 0);
  assert.match(ephemeralFork.stderr, /--(?:no-session cannot be combined with --fork|fork cannot be combined with --no-session)/u);

  const resumeConflict = run(["--workspace", value.workspace, "--no-approve", "--fork", "source", "--session", "other", "hello"]);
  assert.notEqual(resumeConflict.status, 0);
  assert.match(resumeConflict.stderr, /--fork cannot be combined with --session|--fork, --thread\/--session, --session-id, --continue, and --resume are mutually exclusive/u);

  const approved = run(["--workspace", value.workspace, "--approve", "hello"]);
  assert.notEqual(approved.status, 0);
  assert.doesNotMatch(approved.stderr, /Unable to parse|valid JSON|Unexpected token/iu);
  const denied = run(["--workspace", value.workspace, "--no-approve", "hello"]);
  assert.notEqual(denied.status, 0);
  assert.doesNotMatch(denied.stderr, /Unable to parse|valid JSON|Unexpected token/iu);

  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  await chmod(agentDirectory, 0o700);
  const globalSettings = join(agentDirectory, "settings.json");
  await writeFile(globalSettings, JSON.stringify({ defaultProjectTrust: "never" }));
  const defaultDenied = run(["--workspace", value.workspace, "hello"]);
  assert.notEqual(defaultDenied.status, 0);
  assert.doesNotMatch(defaultDenied.stderr, /Unable to parse|valid JSON|Unexpected token/iu);
  await writeFile(globalSettings, JSON.stringify({ defaultProjectTrust: "always" }));
  const defaultApproved = run(["--workspace", value.workspace, "hello"]);
  assert.notEqual(defaultApproved.status, 0);
  assert.doesNotMatch(defaultApproved.stderr, /Unable to parse|valid JSON|Unexpected token/iu);
  assert.deepEqual(await new TrustStore(join(agentDirectory, "trusted-workspaces.json")).list(), []);
});

test("an explicit one-shot TTY run does not open the project trust chooser", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const value = await fixture(context, "harness-project-trust-run-tty-");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "settings.json"), "{ ignored while untrusted");
  const agentDirectory = join(value.root, "agent");
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RIGYN_CODING_AGENT_DIR: agentDirectory,
    XDG_STATE_HOME: join(value.root, "runtime-state"),
    NO_COLOR: "1",
  };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  const command = [
    process.execPath,
    "--import", "tsx", cliSourcePath,
    "--print", "--workspace", value.workspace, "hello",
  ].map(shellQuote).join(" ");
  const result = spawnSync("script", ["-qefc", command, "/dev/null"], {
    cwd: packageRoot,
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Project resources found/u);
  assert.deepEqual(await new TrustStore(join(agentDirectory, "trusted-workspaces.json")).list(), []);
});
