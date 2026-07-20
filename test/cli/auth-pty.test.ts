import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createCredentialStore } from "../../src/cli/runtime.js";
import { harnessPaths } from "../../src/cli/paths.js";
import { CredentialProfileManager } from "../../src/auth/index.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForOutput(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read().slice(-16 * 1024)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function waitForOutputAfter(read: () => string, offset: number, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!read().slice(offset).includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read().slice(-16 * 1024)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

test("PTY login refreshes a configured device credential, selects a model, logs out, and Escape cancels a pending retry", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let pending = false;
  let refreshRequests = 0;
  let modelRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/device") {
      response.end(JSON.stringify({
        device_code: pending ? "pending-device-secret" : "device-secret",
        user_code: pending ? "WAIT-CODE" : "LOGIN-CODE",
        verification_uri: `http://127.0.0.1:${(server.address() as { port: number }).port}/verify`,
        expires_in: 60,
        interval: 1,
      }));
      return;
    }
    if (request.url === "/v1/models") {
      modelRequests += 1;
      assert.equal(request.headers.authorization, "Bearer refreshed-access");
      response.end(JSON.stringify({ data: [{ id: "corp-code", name: "Corp Code", context_length: 64_000 }] }));
      return;
    }
    if (request.url !== "/token") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (pending) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "authorization_pending" }));
      } else if (body.get("grant_type") === "refresh_token") {
        refreshRequests += 1;
        response.end(JSON.stringify({ access_token: "refreshed-access", token_type: "Bearer", expires_in: 3600 }));
      } else {
        response.end(JSON.stringify({
          access_token: "initial-access",
          refresh_token: "refresh-secret",
          token_type: "Bearer",
          expires_in: 1,
          scope: "models.read",
        }));
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  const root = await mkdtemp(join(tmpdir(), "harness-auth-pty-"));
  const workspace = join(root, "workspace");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    RIGYN_TUI_MODE: "full",
    TERM: "xterm-256color",
    NO_COLOR: "1",
  };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  await mkdir(workspace);
  const paths = harnessPaths(environment);
  await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
  await writeFile(paths.globalConfig, JSON.stringify({
    providers: {
      corp: {
        kind: "openai-compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        credentialProvider: "corp-account",
      },
    },
  }));
  const extension = join(paths.userExtensions, "dynamic-auth");
  await mkdir(join(extension, "runtime"), { recursive: true });
  await writeFile(join(extension, "extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dynamic-auth",
    name: "Dynamic auth fixture",
    version: "1.0.0",
    contributions: { runtime: [{ path: "runtime/index.mjs" }] },
  }));
  await writeFile(join(extension, "runtime", "index.mjs"), `export default (api) => {
    api.registerProviderAuth({
      provider: "corp",
      credentialId: "corp-account",
      displayName: "Corporate Models",
      methods: [{
        kind: "oauth_device",
        id: "workforce",
        label: "Company account",
        detail: "Device authorization · 127.0.0.1:${port}",
        clientId: "public-client",
        deviceEndpoint: "http://127.0.0.1:${port}/device",
        tokenEndpoint: "http://127.0.0.1:${port}/token",
        scopes: ["models.read"],
      }],
    });
  };\n`);

  const command = [
    process.execPath,
    "--import",
    "tsx",
    resolve("src/bin/rigyn.ts"),
    "chat",
    "--workspace",
    workspace,
    "--no-browser",
  ].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: resolve("."),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  const read = () => rendered;

  await waitForOutput(read, "Rigyn v0.3.0 · Ready");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
  assert.doesNotMatch(read(), /Model catalogs:/u);
  child.stdin.write("/login\r");
  await waitForOutput(read, "Use a subscription");
  child.stdin.write("\r");
  await waitForOutput(read, "Select subscription provider");
  child.stdin.write("corp\r");
  await waitForOutput(read, "LOGIN-CODE");
  await waitForOutput(read, "Connected corp via stored. Use /model or Ctrl+L to choose a model.");
  child.stdin.write("/model corp/corp-code\r");
  await waitForOutput(read, "Model corp/corp-code");
  assert.ok(refreshRequests >= 1);
  assert.ok(modelRequests >= 1);

  const store = await createCredentialStore(paths, { environment, allowPlatformKeychain: false });
  const profiles = new CredentialProfileManager(store, "corp-account");
  const defaultCredential = await profiles.read("default");
  assert.ok(defaultCredential !== undefined);
  await profiles.create("work", defaultCredential);

  child.stdin.write("/logout corp\r");
  await waitForOutput(read, "Signed out for corp");
  assert.equal(await store.read("corp-account"), undefined);
  assert.deepEqual((await profiles.state()).profiles.map((entry) => ({ name: entry.name, active: entry.active })), [
    { name: "work", active: false },
  ]);

  const profileLoginOffset = read().length;
  child.stdin.write("/login corp\r");
  await waitForOutputAfter(read, profileLoginOffset, "Credential profile for corp");
  child.stdin.write("work\r");
  await waitForOutputAfter(read, profileLoginOffset, "Connected corp via stored");
  assert.equal((await profiles.state()).activeProfile, "work");
  child.stdin.write("/logout corp\r");
  await waitForOutputAfter(read, profileLoginOffset, "Signed out for corp profile work");
  assert.deepEqual((await profiles.state()).profiles, []);

  pending = true;
  const secondLoginOffset = read().length;
  child.stdin.write("/login corp\r");
  await waitForOutputAfter(read, secondLoginOffset, "Connect corp");
  child.stdin.write("\r");
  await waitForOutputAfter(read, secondLoginOffset, "WAIT-CODE");
  child.stdin.write("\u001b");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  child.stdin.write("/session\r");
  await waitForOutputAfter(read, secondLoginOffset, "Messages: 0 user · 0 assistant · 0 tool");
  assert.doesNotMatch(read().slice(secondLoginOffset), /Command failed: authorization cancelled/u);
  child.stdin.write("/exit\r");
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Chat did not exit:\n${read().slice(-16 * 1024)}`));
    }, 10_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  assert.equal(exitCode, 0, read());
});
