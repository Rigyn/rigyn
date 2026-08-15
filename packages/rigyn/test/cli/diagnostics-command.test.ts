import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createDiagnosticBundle,
  safeError,
  sanitizeDiagnosticText,
} from "../../src/cli/diagnostics-command.js";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { TrustStore } from "../../src/config/trust.js";

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-diagnostics-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const workspace = join(home, "workspace");
  const agentDirectory = join(home, ".rigyn");
  const stateHome = join(home, "state");
  const stateDirectory = join(stateHome, "rigyn");
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  if (process.platform !== "win32") {
    await chmod(agentDirectory, 0o700);
    await chmod(stateHome, 0o700);
    await chmod(stateDirectory, 0o700);
  }
  return {
    root,
    home,
    workspace,
    agentDirectory,
    stateDirectory,
    environment: {
      ...process.env,
      HOME: home,
      RIGYN_HOME: agentDirectory,
      XDG_STATE_HOME: stateHome,
      OPENAI_API_KEY: ["sk", "proj", "ENVIRONMENT_SENTINEL_123456789"].join("-"),
    } satisfies NodeJS.ProcessEnv,
  };
}

test("diagnostic bundles expose bounded status and timings without secret-bearing values", async (context) => {
  const value = await fixture(context);
  const sentinels = [
    "CONFIGURATION_VALUE_SENTINEL",
    "EXTENSION_DESCRIPTION_SENTINEL",
    "SKILL_DESCRIPTION_SENTINEL",
    "CREDENTIAL_FILE_SENTINEL",
    "SESSION_CONTENT_SENTINEL",
    "ENVIRONMENT_SENTINEL",
  ];
  await writeFile(join(value.agentDirectory, "config.json"), JSON.stringify({
    defaultModel: sentinels[0],
    httpProxy: "https://user:password@example.invalid",
  }));
  await writeFile(join(value.agentDirectory, "auth.json"), sentinels[3]!, { mode: 0o600 });
  await mkdir(join(value.agentDirectory, "sessions"), { recursive: true });
  await writeFile(join(value.agentDirectory, "sessions", "fixture.jsonl"), sentinels[4]!, { mode: 0o600 });

  const extension = join(value.agentDirectory, "extensions", "diagnostic-fixture");
  await mkdir(join(extension, "extensions"), { recursive: true });
  await writeFile(join(extension, "package.json"), JSON.stringify({
    name: "diagnostic-fixture",
    version: "1.2.3",
    description: sentinels[1],
    type: "module",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(extension, "extensions", "index.mjs"), "export default function activate() {}\n");
  const userSkill = join(value.home, ".codex", "skills", "diagnostic-skill");
  await mkdir(userSkill, { recursive: true });
  await writeFile(join(userSkill, "SKILL.md"), `---\nname: diagnostic-skill\ndescription: ${sentinels[2]}\n---\nsecret body\n`);
  const projectSkill = join(value.workspace, ".claude", "skills", "project-skill");
  await mkdir(projectSkill, { recursive: true });
  await writeFile(join(projectSkill, "SKILL.md"), "---\nname: project-skill\ndescription: trusted project skill\n---\nbody\n");
  await new TrustStore(join(value.agentDirectory, "trusted-workspaces.json")).trust(value.workspace);

  const bundle = await createDiagnosticBundle({
    workspace: value.workspace,
    environment: value.environment,
    homeDirectory: value.home,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  const serialized = JSON.stringify(bundle);
  assert.equal(bundle.createdAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(bundle.privacy, {
    credentialsRead: false,
    sessionContentRead: false,
    configurationValuesIncluded: false,
    resourceBodiesIncluded: false,
    operationalLogContentRead: false,
  });
  assert.equal(bundle.observability.level, "debug");
  assert.equal(bundle.observability.fileCount, 0);
  assert.equal(bundle.observability.partial, false);
  assert.deepEqual(bundle.configuration.global.keys, ["defaultModel", "httpProxy"]);
  assert.equal(bundle.paths.auth?.kind, "file");
  assert.equal(bundle.workspace.path, "<workspace>");
  assert.equal(bundle.workspace.trusted, true);
  assert.deepEqual(bundle.resources.extensions.map((entry) => entry.id), ["diagnostic-fixture"]);
  assert.deepEqual(
    bundle.resources.skills.map((entry) => entry.name).sort(),
    ["diagnostic-skill", "project-skill", "rigyn-dev"],
  );
  assert.ok(Object.values(bundle.timingsMs).every((duration) => Number.isFinite(duration) && duration >= 0));
  for (const sentinel of sentinels) assert.doesNotMatch(serialized, new RegExp(sentinel, "u"));
  assert.doesNotMatch(serialized, /user:password/u);
  assert.doesNotMatch(serialized, new RegExp(value.home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("diagnostic bundles redact credential-shaped skill names", async (context) => {
  const value = await fixture(context);
  const secret = "sk-proj-abcdefghijklmnop";
  const userSkill = join(value.home, ".codex", "skills", "credential-shaped-name");
  await mkdir(userSkill, { recursive: true });
  await writeFile(
    join(userSkill, "SKILL.md"),
    `---\nname: ${secret}\ndescription: diagnostic fixture\n---\nbody\n`,
  );

  const bundle = await createDiagnosticBundle({
    workspace: value.workspace,
    environment: value.environment,
    homeDirectory: value.home,
  });

  assert.equal(bundle.resources.skills.some((entry) => entry.name === "[REDACTED]"), true);
  assert.doesNotMatch(JSON.stringify(bundle), new RegExp(secret, "u"));
});

test("diagnostics cannot report the active Rigyn home as trusted project scope", async (context) => {
  const value = await fixture(context);
  await writeFile(join(value.agentDirectory, "config.json"), JSON.stringify({ theme: "mono" }));
  await new TrustStore(join(value.agentDirectory, "trusted-workspaces.json")).trust(value.home);

  const bundle = await createDiagnosticBundle({
    workspace: value.home,
    environment: value.environment,
    homeDirectory: value.home,
  });

  assert.equal(bundle.workspace.trusted, false);
  assert.deepEqual(bundle.workspace.detectedProjectResources, []);
  assert.equal(bundle.configuration.global.status, "valid");
  assert.equal(bundle.configuration.project.status, "ignored");
  assert.deepEqual(bundle.configuration.appliedSources, ["global"]);
});

test("diagnostic skill inventory uses the runtime's first-definition-wins ordering", async (context) => {
  const value = await fixture(context);
  const first = join(value.home, ".agents", "skills", "shared");
  const second = join(value.home, ".claude", "skills", "shared");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(first, "SKILL.md"), "---\nname: shared\ndescription: first definition\n---\nbody\n");
  await writeFile(join(second, "SKILL.md"), "---\nname: shared\ndescription: second definition\n---\nbody\n");

  const bundle = await createDiagnosticBundle({
    workspace: value.workspace,
    environment: value.environment,
    homeDirectory: value.home,
  });
  const selected = bundle.resources.skills.find((entry) => entry.name === "shared");
  assert.equal(selected?.manifestPath, join("~", ".agents", "skills", "shared", "SKILL.md"));
  assert.equal(
    bundle.resources.skillDiagnostics.some((entry) => entry.code === "SKILL_COLLISION"),
    true,
  );
});

test("diagnostic package identities redact configured local paths", async (context) => {
  const value = await fixture(context);
  const extension = join(value.home, "PRIVATE_PACKAGE_PATH_SENTINEL", "extension");
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, "package.json"), JSON.stringify({
    name: "private-path-fixture",
    type: "module",
    rigyn: { extensions: ["index.mjs"] },
  }));
  await writeFile(join(extension, "index.mjs"), "export default function activate() {}\n");
  await writeFile(join(value.agentDirectory, "config.json"), JSON.stringify({ packages: [extension] }));

  const bundle = await createDiagnosticBundle({
    workspace: value.workspace,
    environment: value.environment,
    homeDirectory: value.home,
  });
  const serialized = JSON.stringify(bundle);
  assert.equal(bundle.resources.extensions.length, 1);
  assert.equal(bundle.resources.extensions[0]?.id, join("~", "PRIVATE_PACKAGE_PATH_SENTINEL", "extension"));
  assert.doesNotMatch(serialized, new RegExp(value.home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("diagnostic extension summaries count active declared contributions by kind", async (context) => {
  const value = await fixture(context);
  const extension = join(value.home, "declared-diagnostics-extension");
  await mkdir(join(extension, "runtime"), { recursive: true });
  await mkdir(join(extension, "skills", "one"), { recursive: true });
  await mkdir(join(extension, "templates"), { recursive: true });
  await mkdir(join(extension, "themes"), { recursive: true });
  await writeFile(join(extension, "package.json"), JSON.stringify({
    name: "declared-diagnostics-extension",
    version: "1.0.0",
    type: "module",
  }));
  await writeFile(join(extension, "runtime", "index.mjs"), "export default function activate() {}\n");
  await writeFile(
    join(extension, "skills", "one", "SKILL.md"),
    "---\nname: diagnostic-one\ndescription: Diagnostic skill\n---\nBody\n",
  );
  await writeFile(join(extension, "templates", "shared.md"), "Shared template\n");
  await writeFile(join(extension, "themes", "one.json"), JSON.stringify({
    schemaVersion: 1,
    name: "diagnostic-theme-one",
    base: "dark",
    styles: {},
  }));
  await writeFile(join(extension, "themes", "two.json"), JSON.stringify({
    schemaVersion: 1,
    name: "diagnostic-theme-two",
    base: "dark",
    styles: {},
  }));
  await writeFile(join(extension, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "declared-diagnostics",
    name: "Declared diagnostics",
    version: "1.0.0",
    contributions: {
      runtime: [{ path: "runtime/index.mjs" }],
      skillRoots: [{ path: "skills" }],
      prompts: [
        { id: "diagnostic-prompt-one", path: "templates/shared.md" },
        { id: "diagnostic-prompt-two", path: "templates/shared.md" },
      ],
      commands: [{ name: "diagnostic-command", path: "templates/shared.md" }],
      themes: [
        { name: "diagnostic-theme-one", path: "themes/one.json" },
        { name: "diagnostic-theme-two", path: "themes/two.json" },
      ],
    },
  }));
  await writeFile(join(value.agentDirectory, "config.json"), JSON.stringify({ packages: [extension] }));

  const bundle = await createDiagnosticBundle({
    workspace: value.workspace,
    environment: value.environment,
    homeDirectory: value.home,
  });

  assert.deepEqual(bundle.resources.extensions[0]?.contributions, {
    skillRoots: 1,
    prompts: 2,
    commands: 1,
    themes: 2,
    runtime: 1,
  });
});

test("diagnostic settings inspection honors the runtime size bound", async (context) => {
  const value = await fixture(context);
  await writeFile(
    join(value.agentDirectory, "config.json"),
    JSON.stringify({ keybindings: { oversized: "x".repeat(256 * 1024) } }),
  );

  const bundle = await createDiagnosticBundle({
    workspace: value.workspace,
    environment: value.environment,
    homeDirectory: value.home,
  });
  assert.equal(bundle.configuration.global.status, "invalid");
  assert.match(bundle.configuration.global.error ?? "", /exceeds 262144 bytes/u);
});

test("diagnostic configuration status includes schema validation", async (context) => {
  const value = await fixture(context);
  await writeFile(join(value.agentDirectory, "config.json"), JSON.stringify({ transport: "webtransport" }));

  const bundle = await createDiagnosticBundle({
    workspace: value.workspace,
    environment: value.environment,
    homeDirectory: value.home,
  });
  assert.equal(bundle.configuration.global.status, "invalid");
  assert.equal(bundle.configuration.global.error, "Settings file does not match the supported schema");
});

test("malformed settings cannot echo configuration source text into diagnostics", async (context) => {
  const value = await fixture(context);
  await writeFile(join(value.agentDirectory, "config.json"), "PRIVATE_CONFIGURATION_SENTINEL");

  const bundle = await createDiagnosticBundle({
    workspace: value.workspace,
    environment: value.environment,
    homeDirectory: value.home,
  });
  const serialized = JSON.stringify(bundle);
  assert.equal(bundle.configuration.global.status, "invalid");
  assert.equal(bundle.configuration.global.error, "Settings file is not valid JSON");
  assert.equal(
    bundle.errors.find((entry) => entry.section === "settings")?.message,
    "Settings could not be loaded; see configuration status",
  );
  assert.doesNotMatch(serialized, /PRIVATE_CO|PRIVATE_CONFIGURATION_SENTINEL/u);
});

test("resource diagnostics cannot echo manifest or skill source text", async (context) => {
  const value = await fixture(context);
  const plugin = join(value.home, "diagnostic-plugin");
  const portableSkill = join(plugin, "skills", "broken");
  const ordinarySkill = join(value.home, ".codex", "skills", "broken");
  await mkdir(portableSkill, { recursive: true });
  await mkdir(ordinarySkill, { recursive: true });
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "diagnostic-plugin",
    PRIVATE_PLUGIN_FIELD_SENTINEL: true,
  }));
  await writeFile(
    join(portableSkill, "SKILL.md"),
    "---\ndescription: [PRIVATE_PORTABLE_SKILL_SENTINEL\n---\nbody\n",
  );
  await writeFile(
    join(ordinarySkill, "SKILL.md"),
    "---\ndescription: [PRIVATE_ORDINARY_SKILL_SENTINEL\n---\nbody\n",
  );
  await writeFile(join(value.agentDirectory, "config.json"), JSON.stringify({ packages: [plugin] }));

  const bundle = await createDiagnosticBundle({
    workspace: value.workspace,
    environment: value.environment,
    homeDirectory: value.home,
  });
  const serialized = JSON.stringify(bundle);
  assert.ok(bundle.resources.extensionDiagnostics.length > 0);
  assert.ok(bundle.resources.skillDiagnostics.length > 0);
  assert.doesNotMatch(
    serialized,
    /PRIVATE_PLUGIN_FIELD_SENTINEL|PRIVATE_PORTABLE_SKILL_SENTINEL|PRIVATE_ORDINARY_SKILL_SENTINEL/u,
  );
});

test("diagnostic text redacts common credential forms and normalizes local paths", () => {
  const result = sanitizeDiagnosticText(
    "/home/example/workspace failed with Bearer abcdefghijklmnop and sk-proj-abcdefghijklmnop and https://user:pass@example.test?a=1&token=secret",
    "/home/example/workspace",
    "/home/example",
  );
  assert.match(result, /<workspace>/u);
  assert.match(result, /Bearer \[redacted\]/u);
  assert.doesNotMatch(result, /abcdefghijklmnop|user:pass|token=secret/u);
  assert.equal(
    sanitizeDiagnosticText(
      "/home/example/workspace/npm:file:/home/example/private/package.tgz",
      "/home/example/workspace",
      "/home/example",
    ),
    "<workspace>/npm:file:~/private/package.tgz",
  );
  assert.equal(sanitizeDiagnosticText("plain", "", ""), "plain");
});

test("diagnostic text pre-bounds huge input and redacts a registered secret across the cutoff", () => {
  const marker = "LEAK-diagnostic-max-cutoff-secret-";
  const secret = `${marker}${"s".repeat((64 * 1_024) - marker.length)}`;
  defaultSecretRedactor.register(secret);
  const input = `${"x".repeat(4_080)}${secret}-tail${"z".repeat(16 * 1_024 * 1_024)}`;

  const result = sanitizeDiagnosticText(input, "", "");

  assert.equal(Buffer.byteLength(result, "utf8") <= 4 * 1_024, true);
  assert.match(result, /\[REDACTED\]/u);
  assert.doesNotMatch(result, /LEAK-diagnostic-max-cutoff/u);
});

test("diagnostic error capture contains hostile thrown values without reflection", () => {
  let traps = 0;
  const source = new Error("hidden diagnostic message");
  Object.defineProperty(source, "message", {
    configurable: true,
    get() { traps += 1; throw new Error("message getter executed"); },
  });
  const proxy = new Proxy(Object.create(null) as object, {
    get() { traps += 1; throw new Error("get trap executed"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap executed"); },
  });
  const convertible = Object.create(null) as object;
  Object.defineProperty(convertible, Symbol.toPrimitive, {
    configurable: true,
    value() { traps += 1; throw new Error("conversion hook executed"); },
  });

  assert.equal(safeError(source, "", ""), "[Thrown Error]");
  assert.equal(safeError(proxy, "", ""), "[Thrown object]");
  assert.equal(safeError(convertible, "", ""), "[Thrown object]");
  assert.equal(traps, 0);
});

test("diagnostics CLI writes an exclusive owner-only JSON bundle", async (context) => {
  const value = await fixture(context);
  const output = join(value.root, "support", "bundle.json");
  const result = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/rigyn.ts"),
    "diagnostics", output, "--workspace", value.workspace,
  ], {
    cwd: resolve("."),
    env: value.environment,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Wrote redacted diagnostic bundle/u);
  const parsed = JSON.parse(await readFile(output, "utf8")) as { kind?: string };
  assert.equal(parsed.kind, "rigyn-diagnostics");
  if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);

  const second = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/rigyn.ts"),
    "diagnostics", output, "--workspace", value.workspace,
  ], { cwd: resolve("."), env: value.environment, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /EEXIST|exist/iu);
});
