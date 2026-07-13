import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createDiagnosticBundle,
  sanitizeDiagnosticText,
} from "../../src/cli/diagnostics-command.js";
import { TrustStore } from "../../src/config/trust.js";

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-diagnostics-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const workspace = join(home, "workspace");
  const configHome = join(home, "config");
  const stateHome = join(home, "state");
  const configDirectory = join(configHome, "rigyn");
  const stateDirectory = join(stateHome, "rigyn");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  if (process.platform !== "win32") {
    await chmod(configHome, 0o700);
    await chmod(configDirectory, 0o700);
    await chmod(stateHome, 0o700);
    await chmod(stateDirectory, 0o700);
  }
  return {
    root,
    home,
    workspace,
    configDirectory,
    stateDirectory,
    environment: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
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
  await writeFile(join(value.configDirectory, "config.jsonc"), JSON.stringify({
    defaultModel: sentinels[0],
    httpTransport: { proxy: { https: "https://user:password@example.invalid" } },
  }));
  await writeFile(join(value.configDirectory, "credentials.enc"), sentinels[3]!, { mode: 0o600 });
  await writeFile(join(value.stateDirectory, "sessions.sqlite"), sentinels[4]!, { mode: 0o600 });

  const extension = join(value.configDirectory, "extensions", "diagnostic-fixture");
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "diagnostic-fixture",
    name: "Diagnostic fixture",
    version: "1.2.3",
    description: sentinels[1],
    contributions: {},
  }));
  const userSkill = join(value.home, ".codex", "skills", "diagnostic-skill");
  await mkdir(userSkill, { recursive: true });
  await writeFile(join(userSkill, "SKILL.md"), `---\nname: diagnostic-skill\ndescription: ${sentinels[2]}\n---\nsecret body\n`);
  const projectSkill = join(value.workspace, ".claude", "skills", "project-skill");
  await mkdir(projectSkill, { recursive: true });
  await writeFile(join(projectSkill, "SKILL.md"), "---\nname: project-skill\ndescription: trusted project skill\n---\nbody\n");
  await new TrustStore(join(value.configDirectory, "trusted-workspaces.json")).trust(value.workspace);

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
  });
  assert.deepEqual(bundle.configuration.global.keys, ["defaultModel", "httpTransport"]);
  assert.equal(bundle.paths.credentialStore?.kind, "file");
  assert.equal(bundle.workspace.path, "<workspace>");
  assert.equal(bundle.workspace.trusted, true);
  assert.deepEqual(bundle.resources.extensions.map((entry) => entry.id), ["diagnostic-fixture"]);
  assert.deepEqual(bundle.resources.skills.map((entry) => entry.name).sort(), ["diagnostic-skill", "project-skill"]);
  assert.ok(Object.values(bundle.timingsMs).every((duration) => Number.isFinite(duration) && duration >= 0));
  for (const sentinel of sentinels) assert.doesNotMatch(serialized, new RegExp(sentinel, "u"));
  assert.doesNotMatch(serialized, /user:password/u);
  assert.doesNotMatch(serialized, new RegExp(value.home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
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
  assert.equal(sanitizeDiagnosticText("plain", "", ""), "plain");
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
