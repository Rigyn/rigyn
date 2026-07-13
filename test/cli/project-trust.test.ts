import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

import {
  discoverProjectTrustResources,
  ProjectTrustResolver,
} from "../../src/cli/project-trust.js";
import { TrustStore } from "../../src/config/trust.js";
import type { TerminalChoice, TerminalPrompter } from "../../src/interfaces/terminal.js";

const execFileAsync = promisify(execFile);

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

test("resource discovery is metadata-only and covers config, package declarations, prompts, extensions, and compatible skills", async (context) => {
  const value = await fixture(context, "harness-project-trust-discovery-");
  await mkdir(join(value.workspace, ".rigyn", "extensions", "demo"), { recursive: true });
  await mkdir(join(value.workspace, ".rigyn", "packages", "managed"), { recursive: true });
  await mkdir(join(value.workspace, ".rigyn", "skills", "local"), { recursive: true });
  await mkdir(join(value.workspace, ".rigyn", "prompts"), { recursive: true });
  await mkdir(join(value.workspace, ".rigyn", "themes"), { recursive: true });
  await mkdir(join(value.workspace, ".agents", "skills", "compatible"), { recursive: true });
  await mkdir(join(value.workspace, ".claude", "skills", "compatible"), { recursive: true });
  await mkdir(join(value.workspace, ".codex", "skills", "compatible"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "config.jsonc"), "not parsed during discovery");
  await writeFile(join(value.workspace, ".rigyn", "packages.json"), "not parsed during discovery");
  await writeFile(join(value.workspace, ".rigyn", "packages.lock.json"), "not parsed during discovery");
  await writeFile(join(value.workspace, ".rigyn", "SYSTEM.md"), "not read during discovery");
  await writeFile(join(value.workspace, ".rigyn", "extensions", "demo", "extension.json"), "{}");
  await writeFile(join(value.workspace, ".rigyn", "skills", "local", "SKILL.md"), "local");
  await writeFile(join(value.workspace, ".rigyn", "prompts", "review.md"), "review");
  await writeFile(join(value.workspace, ".rigyn", "themes", "ocean.json"), "{}");
  await writeFile(join(value.workspace, ".agents", "skills", "compatible", "SKILL.md"), "compatible");
  await writeFile(join(value.workspace, ".claude", "skills", "compatible", "SKILL.md"), "compatible");
  await writeFile(join(value.workspace, ".codex", "skills", "compatible", "SKILL.md"), "compatible");

  assert.deepEqual(await discoverProjectTrustResources(value.workspace), [
    ".rigyn/config.jsonc",
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
  await writeFile(join(value.workspace, ".rigyn", "config.jsonc"), "{}");
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
  await writeFile(join(value.workspace, ".rigyn", "config.jsonc"), "{}");

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
  await writeFile(join(value.workspace, ".rigyn", "config.jsonc"), "{}");
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
    XDG_CONFIG_HOME: join(value.root, "config"),
    XDG_STATE_HOME: join(value.root, "runtime-state"),
  };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  const inspect = async (projectTrusted: boolean): Promise<string[]> => {
    const script = `
      import { loadRuntime } from "./src/cli/runtime.ts";
      const runtime = await loadRuntime({ workspace: ${JSON.stringify(value.workspace)}, projectTrusted: ${projectTrusted}, ephemeral: true });
      try { process.stdout.write(JSON.stringify(runtime.service.skills.map((skill) => skill.name).sort())); }
      finally { await runtime.close(); }
    `;
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: resolve("."),
      env: environment,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout) as string[];
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
  const configHome = join(value.root, "config");
  const stateHome = join(value.root, "runtime-state");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "config.jsonc"), "{ invalid project config");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    NO_COLOR: "1",
  };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  const run = (argumentsValue: string[]) => spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/rigyn.ts"),
    ...argumentsValue,
  ], { cwd: resolve("."), env: environment, encoding: "utf8" });

  const trustConflict = run(["--workspace", value.workspace, "--approve", "--no-approve", "hello"]);
  assert.notEqual(trustConflict.status, 0);
  assert.match(trustConflict.stderr, /--approve and --no-approve are mutually exclusive/u);

  const ephemeralFork = run(["--workspace", value.workspace, "--no-session", "--fork", "source", "hello"]);
  assert.notEqual(ephemeralFork.status, 0);
  assert.match(ephemeralFork.stderr, /--no-session cannot be combined with --fork/u);

  const resumeConflict = run(["--workspace", value.workspace, "--no-approve", "--fork", "source", "--thread", "other", "hello"]);
  assert.notEqual(resumeConflict.status, 0);
  assert.match(resumeConflict.stderr, /--fork, --thread\/--session, --session-id, --continue, and --resume are mutually exclusive/u);

  const approved = run(["--workspace", value.workspace, "--approve", "hello"]);
  assert.notEqual(approved.status, 0);
  assert.match(approved.stderr, /config|JSON/iu);
  const denied = run(["--workspace", value.workspace, "--no-approve", "hello"]);
  assert.notEqual(denied.status, 0);
  assert.doesNotMatch(denied.stderr, /Unable to parse|valid JSON|Unexpected token/iu);

  await mkdir(join(configHome, "rigyn"), { recursive: true, mode: 0o700 });
  const globalConfig = join(configHome, "rigyn", "config.jsonc");
  await writeFile(globalConfig, JSON.stringify({ defaultProjectTrust: "never" }));
  const defaultDenied = run(["--workspace", value.workspace, "hello"]);
  assert.notEqual(defaultDenied.status, 0);
  assert.doesNotMatch(defaultDenied.stderr, /Unable to parse|valid JSON|Unexpected token/iu);
  await writeFile(globalConfig, JSON.stringify({ defaultProjectTrust: "always" }));
  const defaultApproved = run(["--workspace", value.workspace, "hello"]);
  assert.notEqual(defaultApproved.status, 0);
  assert.match(defaultApproved.stderr, /config|JSON/iu);
  assert.deepEqual(await new TrustStore(join(configHome, "rigyn", "trusted-workspaces.json")).list(), []);
});

test("an explicit one-shot TTY run does not open the project trust chooser", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const value = await fixture(context, "harness-project-trust-run-tty-");
  await mkdir(join(value.workspace, ".rigyn"), { recursive: true });
  await writeFile(join(value.workspace, ".rigyn", "config.jsonc"), "{ ignored while untrusted");
  const configHome = join(value.root, "config");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: join(value.root, "runtime-state"),
    NO_COLOR: "1",
  };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  const command = [
    process.execPath,
    "--import", "tsx", resolve("src/bin/rigyn.ts"),
    "--print", "--workspace", value.workspace, "hello",
  ].map(shellQuote).join(" ");
  const result = spawnSync("script", ["-qefc", command, "/dev/null"], {
    cwd: resolve("."),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Project resources found/u);
  assert.deepEqual(await new TrustStore(join(configHome, "rigyn", "trusted-workspaces.json")).list(), []);
});
