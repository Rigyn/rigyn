import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createCredentialStore } from "../../src/cli/runtime.js";
import { agentPaths } from "../../src/cli/paths.js";
import { RIGYN_VERSION } from "../../src/version.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForOutput(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read().slice(-16 * 1024)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function waitForOutputAfter(read: () => string, offset: number, expected: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!read().slice(offset).includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read().slice(-16 * 1024)}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

test("PTY login stores an extension-provided device credential, selects a model, logs out, and Escape cancels a pending retry", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  let pending = false;
  let refreshRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Connection", "close");
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
    RIGYN_HOME: join(root, "agent"),
    TERM: "xterm-256color",
    NO_COLOR: "1",
  };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  delete environment.GEMINI_API_KEY;
  delete environment.OPENROUTER_API_KEY;
  await mkdir(workspace);
  const paths = agentPaths(environment);
  await mkdir(paths.agentDirectory, { recursive: true, mode: 0o700 });
  const extension = join(paths.userExtensions, "dynamic-auth");
  await mkdir(join(extension, "extensions"), { recursive: true });
  await writeFile(join(extension, "package.json"), JSON.stringify({
    name: "dynamic-auth",
    version: "1.0.0",
    type: "module",
    rigyn: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(extension, "extensions", "index.mjs"), `const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };
  async function requestToken(body, signal) {
    const response = await fetch("http://127.0.0.1:${port}/token", {
      method: "POST", headers: FORM_HEADERS, body: new URLSearchParams(body), signal
    });
    return { ok: response.ok, body: await response.json() };
  }
  function waitForRetry(signal) {
    return new Promise((resolveWait, reject) => {
      const timer = setTimeout(resolveWait, 100);
      const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("authorization cancelled")); };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
  export default (rigyn) => {
    rigyn.registerProvider("corp", {
      name: "Corporate Models",
      api: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:${port}/v1",
      models: [{
        id: "corp-code",
        name: "Corp Code",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 4096
      }, {
        id: "corp-compatible",
        name: "Corp Compatible",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 4096
      }, {
        id: "corp-limited",
        name: "Corp Limited",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: null },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 4096
      }],
      oauth: {
        name: "Corporate Models",
        async login(interaction) {
          const deviceResponse = await fetch("http://127.0.0.1:${port}/device", {
            method: "POST",
            headers: FORM_HEADERS,
            body: new URLSearchParams({ client_id: "public-client", scope: "models.read" }),
            signal: interaction.signal
          });
          const device = await deviceResponse.json();
          interaction.onDeviceCode({
            userCode: device.user_code,
            verificationUri: device.verification_uri,
            intervalSeconds: device.interval,
            expiresInSeconds: device.expires_in
          });
          while (true) {
            interaction.signal?.throwIfAborted();
            const result = await requestToken({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: device.device_code,
              client_id: "public-client"
            }, interaction.signal);
            if (result.ok) return {
              access: result.body.access_token,
              refresh: result.body.refresh_token,
              expires: Date.now() + result.body.expires_in * 1000,
              scope: result.body.scope
            };
            if (result.body.error !== "authorization_pending") throw new Error(result.body.error ?? "device authorization failed");
            await waitForRetry(interaction.signal);
          }
        },
        async refreshToken(credential) {
          const result = await requestToken({
            grant_type: "refresh_token",
            refresh_token: credential.refresh,
            client_id: "public-client"
          });
          if (!result.ok) throw new Error(result.body.error ?? "refresh failed");
          return {
            access: result.body.access_token,
            refresh: credential.refresh,
            expires: Date.now() + result.body.expires_in * 1000
          };
        },
        getApiKey(credential) { return credential.access; }
      }
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
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const read = () => rendered;

  await waitForOutput(read, `rigyn ${RIGYN_VERSION} · ready`);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
  assert.doesNotMatch(read(), /Model catalogs:/u);
  child.stdin.write("/login\r");
  await waitForOutput(read, "Use a subscription or provider account");
  child.stdin.write("\r");
  await waitForOutput(read, "Select provider");
  child.stdin.write("corp\r");
  await waitForOutput(read, "LOGIN-CODE");
  await waitForOutput(read, "Connected corp via stored. Use /model or Ctrl+L to choose a model.");
  child.stdin.write("\u001b[200~/model corp/corp-code\u001b[201~\r");
  await waitForOutput(read, "Model corp/corp-code");
  assert.equal(refreshRequests, 0);
  child.stdin.write("/thinking max\r");
  const suffixOffset = read().length;
  child.stdin.write("\u001b[200~/model corp/corp-code:xhigh\u001b[201~\r");
  await waitForOutputAfter(read, suffixOffset, "Model corp/corp-code · thinking max → xhigh");
  child.stdin.write("/thinking max\r");
  const compatibleOffset = read().length;
  child.stdin.write("\u001b[200~/model corp/corp-compatible\u001b[201~\r");
  await waitForOutputAfter(read, compatibleOffset, "Model corp/corp-compatible");
  const compatibleRender = read().slice(compatibleOffset);
  const compatibleMessage = compatibleRender.lastIndexOf("Model corp/corp-compatible");
  assert.notEqual(compatibleMessage, -1);
  assert.doesNotMatch(compatibleRender.slice(compatibleMessage), /thinking max →/u);
  child.stdin.write("\u001b[200~/model corp/corp-limited\u001b[201~\r");
  await waitForOutput(read, "Model corp/corp-limited · thinking max → xhigh");
  assert.doesNotMatch(read(), /does not support thinking level max/u);
  const persisted = JSON.parse(await readFile(paths.settings, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.defaultProvider, "corp");
  assert.equal(persisted.defaultModel, "corp-limited");
  assert.equal(persisted.defaultThinkingLevel, "xhigh");

  const store = await createCredentialStore(paths, { environment, createLocalKey: true });
  child.stdin.write("/logout corp\r");
  await waitForOutput(read, "Signed out for corp");
  assert.equal(await store.read("corp"), undefined);

  pending = true;
  const secondLoginOffset = read().length;
  child.stdin.write("/login corp\r");
  await waitForOutputAfter(read, secondLoginOffset, "WAIT-CODE");
  child.stdin.write("\u001b");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  child.stdin.write("/session\r");
  await waitForOutputAfter(read, secondLoginOffset, "Messages: 0 total · 0 user · 0 assistant");
  assert.doesNotMatch(read().slice(secondLoginOffset), /Command failed: authorization cancelled/u);
  const exitCodePromise = new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Chat did not exit:\n${read().slice(-16 * 1024)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  child.stdin.write("/exit\r");
  const exitCode = await exitCodePromise;
  assert.equal(exitCode, 0, read());
});

test("built CLI /model and /models show subscription models from a stored OAuth credential while offline", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-oauth-model-pty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const pickerLog = join(root, "picker.log");
  const pickerProbe = join(root, "picker-probe.mjs");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    RIGYN_HOME: join(root, "home", ".rigyn"),
    RIGYN_OFFLINE: "1",
    TERM: "xterm-256color",
    NO_COLOR: "1",
  };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    delete environment[name];
  }
  await mkdir(workspace, { recursive: true });
  await writeFile(pickerLog, "");
  await writeFile(pickerProbe, `
import { appendFileSync } from "node:fs";
import { TuiController } from ${JSON.stringify(pathToFileURL(resolve("dist/tui/controller.js")).href)};

let opens = 0;
const openPicker = TuiController.prototype.openPicker;
const pickerInput = new AbortController();
TuiController.prototype.openPicker = function(kind, ...args) {
  if (kind === "model") {
    opens += 1;
    const current = opens;
    appendFileSync(${JSON.stringify(pickerLog)}, "open:" + current + "\\n");
    this.setNormalizedKeyObserver("auth-pty-model-picker", (event) => {
      if (event.key === "escape") appendFileSync(${JSON.stringify(pickerLog)}, "escape:" + current + "\\n");
    }, pickerInput.signal);
  }
  return openPicker.call(this, kind, ...args);
};
`);
  const paths = agentPaths(environment);
  const store = await createCredentialStore(paths, { environment, createLocalKey: true });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${encode({ alg: "none" })}.${encode({
    sub: "offline-user",
    "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" },
  })}.signature`;
  await store.write("openai-codex", {
    kind: "oauth",
    provider: "openai-codex",
    accessToken,
    refreshToken: "offline-refresh",
    expiresAt: Date.now() + 60 * 60_000,
    tokenType: "Bearer",
    scopes: ["openid", "offline_access"],
    accountId: "offline-account",
    subject: "offline-user",
  });

  const command = [
    process.execPath,
    "--import",
    pathToFileURL(pickerProbe).href,
    resolve("dist/bin/rigyn.js"),
    "chat",
    "--workspace",
    workspace,
    "--offline",
    "--no-browser",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-session",
  ].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: resolve("."),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const read = () => rendered;

  await waitForOutput(read, `rigyn ${RIGYN_VERSION} · ready`);
  for (const [index, commandName] of ["model", "models"].entries()) {
    const modelPickerOffset = read().length;
    child.stdin.write(`/${commandName}\r`);
    await waitForOutput(() => readFileSync(pickerLog, "utf8"), `open:${index + 1}`);
    await waitForOutputAfter(read, modelPickerOffset, "Models");
    await waitForOutputAfter(read, modelPickerOffset, "gpt-5.6-sol");
    assert.doesNotMatch(read().slice(modelPickerOffset), /No available models|Connected provider catalogs are unavailable/u);
    child.stdin.write("\u001b");
    await waitForOutput(() => readFileSync(pickerLog, "utf8"), `escape:${index + 1}`);
  }
  child.stdin.write("/exit\r");
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Chat did not exit:\n${read().slice(-16 * 1024)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
  assert.equal(child.exitCode, 0, read());
});
