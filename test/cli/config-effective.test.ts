import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function runConfig(root: string, workspace: string, args: string[]) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    delete environment[name];
  }
  return spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "config",
    "show",
    "--workspace",
    workspace,
    "--json",
    ...args,
  ], {
    cwd: resolve("."),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("config show --effective expands defaults without returning credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-effective-"));
  const workspace = join(root, "workspace");
  const configDirectory = join(root, "config", "rigyn");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(configDirectory, "config.jsonc"), JSON.stringify({
    defaultProvider: "openai-codex",
    httpTransport: {
      proxy: {
        http: "http://operator:private-value@proxy.example:8080",
        https: "http://username-only@proxy.example:8080",
      },
    },
    providers: {
      company: {
        kind: "openai-compatible",
        baseUrl: "https://models.example/v1?client_secret=query-value",
      },
    },
  }));
  await writeFile(join(configDirectory, "credentials.enc"), "must-not-be-returned");

  const result = runConfig(root, workspace, ["--effective"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /private-value|username-only|query-value|must-not-be-returned/u);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output.defaultProvider, "openai-codex");
  assert.equal(output.defaultModel, null);
  assert.equal(output.theme, "light/dark");
  assert.equal(output.thinking, "off");
  assert.equal(output.thinkingBudgets, null);
  assert.deepEqual(output.compaction, { reserveTokens: 16_384, keepRecentTokens: 20_000 });
  assert.deepEqual(output.branchSummary, { reserveTokens: 16_384, skipPrompt: false });
  assert.deepEqual(output.images, { autoResize: true });
  assert.equal(output.enableSkillCommands, true);
  assert.equal(output.showCacheMissNotices, false);
  assert.deepEqual(output.warnings, { anthropicExtraUsage: true });
  assert.deepEqual(output.promptRoots, []);
  assert.deepEqual(output.themeRoots, []);
  assert.equal(output.maxSteps, 64);
  assert.deepEqual(output.childRuns, {
    maxConcurrent: 4,
    defaultMaxSteps: 32,
    maxSteps: 64,
    defaultTimeoutMs: 600_000,
    maxTimeoutMs: 600_000,
    defaultOutputLimitBytes: 65_536,
    maxOutputLimitBytes: 1_048_576,
  });
  assert.equal((output.httpTransport as { proxy: { http: string } }).proxy.http, "http://[REDACTED]@proxy.example:8080");
  assert.equal((output.httpTransport as { proxy: { https: string } }).proxy.https, "http://[REDACTED]@proxy.example:8080");
  assert.equal((output.httpTransport as { connectTimeoutMs: number }).connectTimeoutMs, 10_000);
  assert.equal((output.httpTransport as { headersTimeoutMs: number }).headersTimeoutMs, 300_000);
  assert.equal((output.httpTransport as { bodyTimeoutMs: number }).bodyTimeoutMs, 300_000);
  assert.equal(
    ((output.providers as Record<string, unknown>).company as { baseUrl: string }).baseUrl,
    "https://models.example/v1?client_secret=[REDACTED]",
  );
  assert.equal(typeof output.shellPath, "string");
  assert.deepEqual(output.npmCommand, ["npm"]);
  assert.deepEqual(output.gitCommand, ["git"]);
  assert.equal(output.contextTokenBudget, null);
  assert.equal(output.summaryTokenBudget, null);
  assert.equal(output.executionBackend, null);
  assert.equal((output.providers as Record<string, unknown>).openai !== undefined, true);
  assert.deepEqual(output.sources, ["global"]);
  assert.equal(output.projectIgnored, false);
});

test("config show keeps its existing non-effective shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-config-show-"));
  const workspace = join(root, "workspace");
  const configDirectory = join(root, "config", "rigyn");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(configDirectory, "config.jsonc"), "{\n  \"defaultProvider\": \"anthropic\"\n}\n");

  const result = runConfig(root, workspace, []);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output.defaultProvider, "anthropic");
  assert.equal(Object.hasOwn(output, "maxSteps"), false);
  assert.deepEqual(output.sources, ["global"]);
});
