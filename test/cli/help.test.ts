import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { renderCliHelp } from "../../src/cli/help.js";

function cli(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env, ...overrides };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    delete environment[name];
  }
  return spawnSync(process.execPath, [
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    ...args,
  ], {
    cwd: resolve("."),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("CLI help has concise global and command-specific surfaces", () => {
  const global = renderCliHelp();
  assert.match(global, /^Rigyn \S+ — coding agent/u);
  assert.match(global, /Usage:\n  rigyn \[OPTIONS\] \[@FILES\.\.\.\] \[MESSAGES\.\.\.\]/u);
  assert.match(global, /-p, --print\s+Process messages non-interactively and exit/u);
  assert.ok(global.indexOf("Model:") < global.indexOf("Sessions:"));
  assert.ok(global.indexOf("Sessions:") < global.indexOf("Tools and resources:"));
  assert.ok(global.indexOf("Tools and resources:") < global.indexOf("Other:"));
  assert.match(global, /--extension PATH\s+Load an extension; repeatable/u);
  assert.match(global, /--redact\s+With --export, write a review-required/u);
  assert.match(global, /--allow-scripts\s+Run reviewed dependency lifecycle scripts/u);
  assert.match(global, /--all\s+With continue\/resume\/session, search every indexed workspace/u);
  assert.match(global, /--workspace DIR\s+Use DIR as the project workspace/u);
  assert.match(renderCliHelp("chat"), /--no-extensions\s+Disable automatic extension discovery/u);
  assert.match(renderCliHelp("run"), /-p, --print\s+Process messages non-interactively and exit/u);
  assert.match(renderCliHelp("rpc"), /newline-delimited JSON RPC/u);
  assert.match(renderCliHelp("extensions"), /extensions \[list\|doctor\|commands\|prompts\]/u);
  assert.match(renderCliHelp("extensions"), /extensions author validate\|inspect\|smoke\|reload\|report PACKAGE/u);
  assert.match(renderCliHelp("diagnostics"), /never reads credential values or session content/u);
  assert.match(renderCliHelp("sessions"), /full integrity check and foreign-key check/u);
  assert.match(renderCliHelp("sessions"), /repair --reindex --yes/u);
  assert.match(renderCliHelp("install"), /disabled unless --allow-scripts/u);
  assert.match(renderCliHelp("update"), /only to this update transaction/u);
  assert.match(renderCliHelp("uninstall"), /saved configuration, credentials, sessions/u);
  assert.match(renderCliHelp("self-update"), /atomically replaces/u);
  assert.throws(() => renderCliHelp("unknown"), /Unknown help topic/u);
});

test("subcommand --help exits before loading runtime state", () => {
  const install = cli(["install", "--help"]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /rigyn install SOURCE/u);
  assert.doesNotMatch(install.stdout, /Commands:\n/u);
  assert.equal(install.stderr, "");

  const config = cli(["help", "config"]);
  assert.equal(config.status, 0, config.stderr);
  assert.match(config.stdout, /package resource configuration/u);
  assert.equal(config.stderr, "");

  const extensions = cli(["extensions", "--help"]);
  assert.equal(extensions.status, 0, extensions.stderr);
  assert.match(extensions.stdout, /rigyn extensions \[list\|doctor\|commands\|prompts\]/u);
  assert.equal(extensions.stderr, "");

  const globalHelp = cli(["--help"]);
  assert.equal(globalHelp.status, 0, globalHelp.stderr);
  assert.match(globalHelp.stdout, /Tools and resources:\n/u);
  assert.match(globalHelp.stdout, /Other:\n/u);
  assert.equal(globalHelp.stderr, "");
});

test("recursive harness launches stop at a fixed process-depth boundary", () => {
  const result = cli(["--version"], { RIGYN_RECURSION_DEPTH: "4" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing recursive Rigyn launch at depth 5/u);
  assert.equal(result.stdout, "");
});
