import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";

test("runtime credential commands activate on startup and swap atomically on reload", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-credential-command-runtime-"));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(configHome, "rigyn"), { recursive: true, mode: 0o700 });
  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    state: process.env.XDG_STATE_HOME,
    key: process.env.RIGYN_CREDENTIAL_KEY,
    first: process.env.RIGYN_TEST_COMMAND_FIRST,
    second: process.env.RIGYN_TEST_COMMAND_SECOND,
  };
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.RIGYN_CREDENTIAL_KEY = Buffer.alloc(32, 13).toString("base64url");
  process.env.RIGYN_TEST_COMMAND_FIRST = "first-command-token";
  process.env.RIGYN_TEST_COMMAND_SECOND = "second-command-token";
  context.after(async () => {
    for (const [name, value] of [
      ["XDG_CONFIG_HOME", previous.config],
      ["XDG_STATE_HOME", previous.state],
      ["RIGYN_CREDENTIAL_KEY", previous.key],
      ["RIGYN_TEST_COMMAND_FIRST", previous.first],
      ["RIGYN_TEST_COMMAND_SECOND", previous.second],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const configPath = join(configHome, "rigyn", "config.jsonc");
  const writeCommand = async (variable: string): Promise<void> => {
    await writeFile(configPath, JSON.stringify({
      credentialCommands: {
        company: {
          argv: [
            process.execPath,
            "-e",
            `process.stdout.write(JSON.stringify({type:'api_key',apiKey:process.env.${variable}}))`,
          ],
          environment: [variable],
          cacheTtlMs: 3_600_000,
        },
      },
    }));
  };

  await writeCommand("RIGYN_TEST_COMMAND_FIRST");
  const runtime = await loadRuntime({
    workspace,
    ephemeral: true,
    extensions: false,
    extensionRuntime: false,
  });
  context.after(async () => await runtime.close());
  const first = await runtime.broker.resolve({ provider: "company" });
  assert.equal(first?.source, "external-command");
  assert.equal(first?.credential.kind === "api_key" ? first.credential.apiKey : undefined, "first-command-token");

  await writeCommand("RIGYN_TEST_COMMAND_SECOND");
  await runtime.reload();
  const second = await runtime.broker.resolve({ provider: "company" });
  assert.equal(second?.source, "external-command");
  assert.equal(second?.credential.kind === "api_key" ? second.credential.apiKey : undefined, "second-command-token");
});
