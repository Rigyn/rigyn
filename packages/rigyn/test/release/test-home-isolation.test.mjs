import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";

function inside(root, candidate) {
  const boundary = resolve(root);
  const selected = resolve(candidate);
  return selected === boundary || selected.startsWith(boundary + sep);
}

test("the test process cannot use the invoking user's home or XDG directories", () => {
  const root = process.env.RIGYN_TEST_ISOLATED_ROOT;
  assert.equal(typeof root, "string");
  for (const name of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "RIGYN_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    const value = process.env[name];
    assert.equal(typeof value, "string", `${name} must be isolated by test/setup.mjs`);
    assert.equal(inside(root, value), true, `${name} must remain inside the isolated test root`);
  }
  assert.equal(resolve(tmpdir()), resolve(root), "os.tmpdir() must use the isolated test root");
});

test("child test fixtures stay inside the isolated root and leave with the child process", () => {
  const setup = new URL("../setup.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, [
    "--import",
    setup,
    "--input-type=module",
    "--eval",
    `import { mkdtempSync } from "node:fs";
     import { tmpdir } from "node:os";
     import { join } from "node:path";
     const fixture = mkdtempSync(join(tmpdir(), "rigyn-child-fixture-"));
     process.stdout.write(JSON.stringify({
       fixture,
       root: process.env.RIGYN_TEST_ISOLATED_ROOT,
       temporary: tmpdir()
     }));`,
  ], { encoding: "utf8", env: { ...process.env } });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  try {
    assert.equal(inside(result.root, result.temporary), true);
    assert.equal(inside(result.root, result.fixture), true);
    assert.equal(existsSync(result.root), false);
    assert.equal(existsSync(result.fixture), false);
  } finally {
    rmSync(result.fixture, { recursive: true, force: true });
    rmSync(result.root, { recursive: true, force: true });
  }
});

test("live setup isolates runtime state without exposing the captured auth path to child processes", () => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-live-setup-"));
  try {
    const agentDirectory = join(root, "real-agent");
    const setup = new URL("../setup.mjs", import.meta.url).href;
    const credentialsUrl = new URL("../live/credentials.ts", import.meta.url).href;
    const runtimeUrl = new URL("../../src/cli/runtime.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, [
      "--import",
      setup,
      "--import",
      "tsx",
      "--eval",
      `(async () => {
        const { spawnSync } = await import("node:child_process");
        const { liveCredentialStore } = await import(${JSON.stringify(credentialsUrl)});
        const { loadRuntime } = await import(${JSON.stringify(runtimeUrl)});
        const credentialStore = await liveCredentialStore({ allowPlatformKeychain: false });
        await credentialStore.write("test-provider", {
          kind: "api_key",
          provider: "test-provider",
          apiKey: "test-secret-value"
        });
        let runtimeReads = 0;
        for (let index = 0; index < 2; index += 1) {
          const runtime = await loadRuntime({
            credentialStore: await liveCredentialStore({ allowPlatformKeychain: false }),
            workspace: process.cwd(),
            projectTrusted: false,
            ephemeral: true,
            extensions: false,
            skills: false,
            promptTemplates: false,
            themes: false,
            offline: true
          });
          if ((await runtime.credentials.read("test-provider"))?.kind === "api_key") runtimeReads += 1;
          await runtime.close();
        }
        const inherited = spawnSync(process.execPath, [
          "--eval",
          "process.stdout.write(process.env.RIGYN_TEST_LIVE_AUTH_PATH ?? '')"
        ], { encoding: "utf8", env: { ...process.env } });
        process.stdout.write(JSON.stringify({
          agent: process.env.RIGYN_HOME,
          authPathInEnvironment: Object.hasOwn(process.env, "RIGYN_TEST_LIVE_AUTH_PATH"),
          inheritedPath: inherited.stdout,
          root: process.env.RIGYN_TEST_ISOLATED_ROOT,
          runtimeReads
        }));
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });`,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        RIGYN_LIVE: "1",
        RIGYN_HOME: agentDirectory,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(inside(result.root, result.agent), true);
    assert.equal(result.authPathInEnvironment, false);
    assert.equal(result.inheritedPath, "");
    assert.equal(result.runtimeReads, 2);
    const stored = JSON.parse(readFileSync(join(agentDirectory, "auth.json"), "utf8"));
    assert.equal(stored["test-provider"]?.kind, "api_key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
