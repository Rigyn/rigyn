import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import type { AuthInteraction, OAuthAuth, OAuthCredential } from "../src/auth/types.js";
import {
  prepareOAuthCredentialFile,
  resolveOAuthCredentialFile,
} from "../src/cli/credential-file.js";
import { runAiCli, type AiCliInteractionOwner, type OAuthProviderCandidate } from "../src/cli/main.js";
import { createTerminalAuthInteraction } from "../src/cli/terminal-interaction.js";

class Capture extends Writable {
  readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding));
    callback();
  }
  text(): string { return Buffer.concat(this.chunks).toString("utf8"); }
}

const credential: OAuthCredential = {
  type: "oauth",
  access: "access-value-must-not-be-printed",
  refresh: "refresh-value-must-not-be-printed",
  expires: 4_000_000_000_000,
};

function candidate(id: string, oauth?: OAuthAuth): OAuthProviderCandidate {
  return {
    id,
    name: `${id} provider`,
    auth: oauth === undefined ? {} : { oauth },
  };
}

function oauth(login: OAuthAuth["login"] = async () => credential): OAuthAuth {
  return {
    name: "Test OAuth",
    login,
    async refresh(value) { return value; },
    async toAuth(value) { return { apiKey: value.access }; },
  };
}

function owner(interaction: AuthInteraction, closed: () => void = () => undefined): AiCliInteractionOwner {
  return { interaction, close: closed };
}

function storedCredential(value: OAuthCredential = credential): string {
  return `${JSON.stringify({ version: 1, credentials: { example: value } }, null, 2)}\n`;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(await realpath(tmpdir()), prefix));
}

test("OAuth credential path prefers the models variable and validates explicit configuration", () => {
  const home = resolve("test-home");
  const legacy = resolve("legacy", "oauth.json");
  const preferred = resolve("preferred", "oauth.json");
  assert.equal(resolveOAuthCredentialFile({}, home), join(home, ".rigyn-models", "oauth.json"));
  assert.equal(resolveOAuthCredentialFile({ RIGYN_AI_AUTH_FILE: legacy }, home), legacy);
  assert.equal(resolveOAuthCredentialFile({
    RIGYN_MODELS_AUTH_FILE: preferred,
    RIGYN_AI_AUTH_FILE: "relative-legacy-path",
  }, home), preferred);
  assert.throws(
    () => resolveOAuthCredentialFile({ RIGYN_MODELS_AUTH_FILE: "", RIGYN_AI_AUTH_FILE: legacy }, home),
    /RIGYN_MODELS_AUTH_FILE must not be empty/u,
  );
  assert.throws(
    () => resolveOAuthCredentialFile({ RIGYN_AI_AUTH_FILE: "" }, home),
    /RIGYN_AI_AUTH_FILE must not be empty/u,
  );
  assert.throws(
    () => resolveOAuthCredentialFile({ RIGYN_MODELS_AUTH_FILE: "relative" }, home),
    /RIGYN_MODELS_AUTH_FILE must be an absolute path/u,
  );
  const agentDirectory = resolve("custom-agent");
  assert.throws(
    () => resolveOAuthCredentialFile({
      RIGYN_CODING_AGENT_DIR: agentDirectory,
      RIGYN_MODELS_AUTH_FILE: join(agentDirectory, "auth.json"),
    }, home),
    /must not replace the Rigyn agent credential store/u,
  );
  assert.throws(
    () => resolveOAuthCredentialFile({
      RIGYN_CODING_AGENT_DIR: pathToFileURL(agentDirectory).href,
      RIGYN_MODELS_AUTH_FILE: join(agentDirectory, "auth.json"),
    }, home),
    /must not replace the Rigyn agent credential store/u,
  );
});

test("OAuth credential migration is verified, owner-only, and removes the legacy store last", async (context) => {
  const home = await temporaryDirectory("rigyn-models-migration-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })));
  const legacy = join(home, ".rigyn-ai", "oauth.json");
  const current = join(home, ".rigyn-models", "oauth.json");
  await mkdir(join(home, ".rigyn-ai"), { mode: 0o700 });
  await writeFile(legacy, storedCredential(), { mode: 0o600 });

  assert.equal(await prepareOAuthCredentialFile({}, home), current);
  assert.deepEqual(JSON.parse(await readFile(current, "utf8")), JSON.parse(storedCredential()));
  await assert.rejects(stat(legacy), { code: "ENOENT" });
  if (process.platform !== "win32") {
    assert.equal((await stat(current)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, ".rigyn-models"))).mode & 0o777, 0o700);
  }
});

test("OAuth credential migration never clobbers a new store or runs for explicit paths", async (context) => {
  const home = await temporaryDirectory("rigyn-models-no-clobber-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })));
  const legacy = join(home, ".rigyn-ai", "oauth.json");
  const current = join(home, ".rigyn-models", "oauth.json");
  const replacement = { ...credential, access: "new-store-access" };
  await mkdir(join(home, ".rigyn-ai"), { mode: 0o700 });
  await mkdir(join(home, ".rigyn-models"), { mode: 0o700 });
  await writeFile(legacy, storedCredential(), { mode: 0o600 });
  await writeFile(current, storedCredential(replacement), { mode: 0o600 });

  assert.equal(await prepareOAuthCredentialFile({}, home), current);
  assert.deepEqual(JSON.parse(await readFile(current, "utf8")), JSON.parse(storedCredential(replacement)));
  assert.deepEqual(JSON.parse(await readFile(legacy, "utf8")), JSON.parse(storedCredential()));

  const explicit = join(home, "explicit", "oauth.json");
  assert.equal(await prepareOAuthCredentialFile({ RIGYN_MODELS_AUTH_FILE: explicit }, home), explicit);
  assert.deepEqual(JSON.parse(await readFile(legacy, "utf8")), JSON.parse(storedCredential()));
});

test("concurrent identical OAuth migrations converge without clobbering", async (context) => {
  const home = await temporaryDirectory("rigyn-models-concurrent-migration-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })));
  const legacy = join(home, ".rigyn-ai", "oauth.json");
  const current = join(home, ".rigyn-models", "oauth.json");
  await mkdir(join(home, ".rigyn-ai"), { mode: 0o700 });
  await writeFile(legacy, storedCredential(), { mode: 0o600 });

  assert.deepEqual(
    await Promise.all([
      prepareOAuthCredentialFile({}, home),
      prepareOAuthCredentialFile({}, home),
    ]),
    [current, current],
  );
  assert.deepEqual(JSON.parse(await readFile(current, "utf8")), JSON.parse(storedCredential()));
  await assert.rejects(stat(legacy), { code: "ENOENT" });
});

test("OAuth credential migration rejects unsafe inputs and preserves the legacy store on failure", async (context) => {
  const home = await temporaryDirectory("rigyn-models-unsafe-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(home, { recursive: true, force: true })));
  const legacyDirectory = join(home, ".rigyn-ai");
  const legacy = join(legacyDirectory, "oauth.json");
  const currentDirectory = join(home, ".rigyn-models");
  await mkdir(legacyDirectory, { mode: 0o700 });
  await writeFile(legacy, "not-json", { mode: 0o600 });
  await assert.rejects(prepareOAuthCredentialFile({}, home), /Legacy credential store is not valid JSON/u);
  assert.equal(await readFile(legacy, "utf8"), "not-json");
  await assert.rejects(stat(join(currentDirectory, "oauth.json")), { code: "ENOENT" });

  await writeFile(legacy, storedCredential(), { mode: 0o600 });
  const unsafeTarget = join(home, "unsafe-target");
  await mkdir(unsafeTarget, { mode: 0o700 });
  await symlink(unsafeTarget, currentDirectory);
  await assert.rejects(prepareOAuthCredentialFile({}, home), /real directory/u);
  assert.deepEqual(JSON.parse(await readFile(legacy, "utf8")), JSON.parse(storedCredential()));

  if (process.platform !== "win32") {
    await import("node:fs/promises").then(({ rm }) => rm(currentDirectory, { force: true }));
    await chmod(legacy, 0o644);
    await assert.rejects(prepareOAuthCredentialFile({}, home), /permissions must be 0600/u);
    assert.equal((await stat(legacy)).mode & 0o777, 0o644);
  }
});

test("OAuth credential migration rejects linked legacy directories and destination files", async (context) => {
  const root = await temporaryDirectory("rigyn-models-linked-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));

  const ancestorTarget = join(root, "ancestor-target");
  const ancestorHome = join(ancestorTarget, "home");
  const ancestorLink = join(root, "ancestor-link");
  await mkdir(ancestorHome, { recursive: true, mode: 0o700 });
  await symlink(ancestorTarget, ancestorLink);
  await assert.rejects(prepareOAuthCredentialFile({}, join(ancestorLink, "home")), /must not traverse symbolic links/u);

  const linkedLegacyHome = join(root, "linked-legacy-home");
  const legacyTarget = join(root, "legacy-target");
  await mkdir(linkedLegacyHome, { mode: 0o700 });
  await mkdir(legacyTarget, { mode: 0o700 });
  await writeFile(join(legacyTarget, "oauth.json"), storedCredential(), { mode: 0o600 });
  await symlink(legacyTarget, join(linkedLegacyHome, ".rigyn-ai"));
  await assert.rejects(prepareOAuthCredentialFile({}, linkedLegacyHome), /real directory/u);
  assert.deepEqual(JSON.parse(await readFile(join(legacyTarget, "oauth.json"), "utf8")), JSON.parse(storedCredential()));

  const linkedDestinationHome = join(root, "linked-destination-home");
  const destinationTarget = join(root, "destination-target.json");
  await mkdir(join(linkedDestinationHome, ".rigyn-ai"), { recursive: true, mode: 0o700 });
  await mkdir(join(linkedDestinationHome, ".rigyn-models"), { mode: 0o700 });
  await writeFile(join(linkedDestinationHome, ".rigyn-ai", "oauth.json"), storedCredential(), { mode: 0o600 });
  await writeFile(destinationTarget, storedCredential(), { mode: 0o600 });
  await symlink(destinationTarget, join(linkedDestinationHome, ".rigyn-models", "oauth.json"));
  await assert.rejects(prepareOAuthCredentialFile({}, linkedDestinationHome), /regular file/u);
  assert.deepEqual(
    JSON.parse(await readFile(join(linkedDestinationHome, ".rigyn-ai", "oauth.json"), "utf8")),
    JSON.parse(storedCredential()),
  );
});

test("OAuth CLI help and list expose only OAuth-capable providers", async (context) => {
  const directory = await temporaryDirectory("rigyn-models-cli-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const output = new Capture();
  const error = new Capture();
  assert.equal(await runAiCli({ args: ["--help"], output, error }), 0);
  assert.match(output.text(), /Usage: rigyn-models/u);
  assert.match(output.text(), /RIGYN_MODELS_AUTH_FILE/u);
  assert.match(output.text(), /RIGYN_AI_AUTH_FILE/u);
  assert.match(output.text(), /RIGYN_CODING_AGENT_DIR/u);
  assert.equal(error.text(), "");

  output.chunks.length = 0;
  assert.equal(await runAiCli({
    args: ["list"],
    environment: { RIGYN_AI_AUTH_FILE: join(directory, "oauth.json") },
    providers: [candidate("plain"), candidate("beta", oauth()), candidate("alpha", oauth())],
    output,
    error,
  }), 0);
  assert.doesNotMatch(output.text(), /plain/u);
  assert.match(output.text(), /alpha\s+Test OAuth\s+not authenticated/u);
  assert.match(output.text(), /beta\s+Test OAuth\s+not authenticated/u);
  assert.ok(output.text().indexOf("alpha") < output.text().indexOf("beta"));
});

test("OAuth CLI rejects unknown and non-OAuth providers without creating storage", async (context) => {
  const directory = await temporaryDirectory("rigyn-models-cli-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const path = join(directory, "oauth.json");
  const output = new Capture();
  const error = new Capture();
  assert.equal(await runAiCli({
    args: ["login", "plain"],
    environment: { RIGYN_AI_AUTH_FILE: path },
    providers: [candidate("plain"), candidate("oauth", oauth())],
    output,
    error,
  }), 2);
  assert.match(error.text(), /unknown OAuth provider: plain/u);
  assert.equal((await readdir(directory)).length, 0);
});

test("OAuth CLI selects a provider when login omits its identifier", async (context) => {
  const directory = await temporaryDirectory("rigyn-models-cli-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const path = join(directory, "oauth.json");
  let selectionPrompted = false;
  const interaction: AuthInteraction = {
    async prompt(prompt) {
      assert.equal(prompt.type, "select");
      selectionPrompted = true;
      return "second";
    },
    notify() {},
  };
  assert.equal(await runAiCli({
    args: ["login"],
    environment: { RIGYN_AI_AUTH_FILE: path },
    providers: [candidate("first", oauth()), candidate("second", oauth())],
    output: new Capture(),
    error: new Capture(),
    createInteraction: () => owner(interaction),
  }), 0);
  assert.equal(selectionPrompted, true);
  const stored = JSON.parse(await readFile(path, "utf8")) as { credentials: Record<string, OAuthCredential> };
  assert.deepEqual(Object.keys(stored.credentials), ["second"]);
});

test("OAuth CLI persists a credential atomically with owner-only permissions and never prints it", async (context) => {
  const directory = await temporaryDirectory("rigyn-models-cli-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const path = join(directory, "private", "oauth.json");
  const output = new Capture();
  const error = new Capture();
  const prompts: string[] = [];
  const notifications: string[] = [];
  const method = oauth(async (interaction) => {
    notifications.push("auth");
    interaction.notify({ type: "auth_url", url: "https://accounts.example.test/login", instructions: "Sign in" });
    interaction.notify({ type: "device_code", userCode: "CODE-123", verificationUri: "https://accounts.example.test/device", expiresInSeconds: 60 });
    interaction.notify({ type: "info", message: "Waiting for authorization" });
    prompts.push(await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }] }));
    prompts.push(await interaction.prompt({ type: "text", message: "Tenant" }));
    prompts.push(await interaction.prompt({ type: "secret", message: "Secret" }));
    prompts.push(await interaction.prompt({ type: "manual_code", message: "Code" }));
    return credential;
  });
  const answers = ["browser", "tenant", "secret-answer", "manual-answer"];
  const interaction: AuthInteraction = {
    async prompt() { return answers.shift() ?? ""; },
    notify(event) { notifications.push(event.type); },
  };
  assert.equal(await runAiCli({
    args: ["login", "example"],
    environment: { RIGYN_AI_AUTH_FILE: path },
    providers: [candidate("example", method)],
    output,
    error,
    createInteraction: () => owner(interaction),
  }), 0);
  assert.deepEqual(prompts, ["browser", "tenant", "secret-answer", "manual-answer"]);
  assert.deepEqual(notifications, ["auth", "auth_url", "device_code", "info"]);
  assert.doesNotMatch(`${output.text()}${error.text()}`, /access-value|refresh-value|secret-answer|manual-answer/u);
  assert.equal(error.text(), "");
  const information = await stat(path);
  assert.equal(information.isFile(), true);
  if (process.platform !== "win32") assert.equal(information.mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(path, "utf8")) as { credentials: Record<string, OAuthCredential> };
  assert.deepEqual(stored.credentials.example, credential);
  assert.deepEqual((await readdir(join(directory, "private"))).sort(), ["oauth.json"]);
});

test("OAuth CLI fails closed on malformed and unsafe credential stores", async (context) => {
  const directory = await temporaryDirectory("rigyn-models-cli-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const malformed = join(directory, "malformed.json");
  await writeFile(malformed, "not-json", { mode: 0o600 });
  const output = new Capture();
  const error = new Capture();
  let interactionCreated = false;
  assert.equal(await runAiCli({
    args: ["login", "example"],
    environment: { RIGYN_AI_AUTH_FILE: malformed },
    providers: [candidate("example", oauth())],
    output,
    error,
    createInteraction: () => {
      interactionCreated = true;
      return owner({ async prompt() { return ""; }, notify() {} });
    },
  }), 1);
  assert.match(error.text(), /not valid JSON/u);
  assert.equal(interactionCreated, false);
  assert.equal(await readFile(malformed, "utf8"), "not-json");

  const target = join(directory, "target.json");
  const link = join(directory, "linked.json");
  await writeFile(target, '{"version":1,"credentials":{}}\n', { mode: 0o600 });
  await symlink(target, link);
  error.chunks.length = 0;
  assert.equal(await runAiCli({
    args: ["list"],
    environment: { RIGYN_AI_AUTH_FILE: link },
    providers: [candidate("example", oauth())],
    output,
    error,
  }), 1);
  assert.match(error.text(), /regular file/u);

  if (process.platform !== "win32") {
    const permissive = join(directory, "permissive.json");
    await writeFile(permissive, '{"version":1,"credentials":{}}\n', { mode: 0o600 });
    await chmod(permissive, 0o644);
    error.chunks.length = 0;
    assert.equal(await runAiCli({
      args: ["list"],
      environment: { RIGYN_AI_AUTH_FILE: permissive },
      providers: [candidate("example", oauth())],
      output,
      error,
    }), 1);
    assert.match(error.text(), /permissions must be 0600/u);
  }

  error.chunks.length = 0;
  assert.equal(await runAiCli({
    args: ["list"],
    environment: { RIGYN_AI_AUTH_FILE: join(directory, ".rigyn", "agent", "auth.json") },
    homeDirectory: directory,
    providers: [candidate("example", oauth())],
    output,
    error,
  }), 1);
  assert.match(error.text(), /must not replace the Rigyn agent credential store/u);
});

test("OAuth CLI cancellation returns 130, closes interaction state, and writes nothing", async (context) => {
  const directory = await temporaryDirectory("rigyn-models-cli-");
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const controller = new AbortController();
  let closed = false;
  const interaction: AuthInteraction = {
    signal: controller.signal,
    async prompt() { controller.signal.throwIfAborted(); return ""; },
    notify() {},
  };
  const method = oauth(async () => {
    controller.abort();
    controller.signal.throwIfAborted();
    return credential;
  });
  const output = new Capture();
  const error = new Capture();
  const path = join(directory, "oauth.json");
  assert.equal(await runAiCli({
    args: ["login", "example"],
    environment: { RIGYN_AI_AUTH_FILE: path },
    providers: [candidate("example", method)],
    output,
    error,
    signal: controller.signal,
    createInteraction: () => owner(interaction, () => { closed = true; }),
  }), 130);
  assert.equal(closed, true);
  assert.match(error.text(), /cancelled/u);
  assert.equal((await readdir(directory)).length, 0);
});

test("terminal secret and manual-code prompts do not echo their answers", async () => {
  for (const prompt of [
    { type: "secret" as const, message: "Secret", answer: "top-secret" },
    { type: "manual_code" as const, message: "Code", answer: "authorization-code" },
  ]) {
    const output = new Capture();
    const interaction = createTerminalAuthInteraction({
      input: Readable.from([`${prompt.answer}\n`]),
      output,
    });
    try {
      assert.equal(await interaction.prompt({ type: prompt.type, message: prompt.message }), prompt.answer);
    } finally {
      interaction.close();
    }
    assert.match(output.text(), new RegExp(prompt.message, "u"));
    assert.doesNotMatch(output.text(), new RegExp(prompt.answer, "u"));
  }
});

test("terminal interactions render bounded selections and authentication notifications", async () => {
  const output = new Capture();
  const interaction = createTerminalAuthInteraction({ input: Readable.from(["2\n"]), output });
  try {
    assert.equal(await interaction.prompt({
      type: "select",
      message: "Choose",
      options: [{ id: "one", label: "One" }, { id: "two", label: "Two", description: "Second" }],
    }), "two");
    interaction.notify({ type: "auth_url", url: "https://accounts.example.test/login", instructions: "Continue in the browser" });
    interaction.notify({ type: "device_code", userCode: "ABCD", verificationUri: "https://accounts.example.test/device", expiresInSeconds: 30 });
    interaction.notify({ type: "info", message: "Waiting", links: [{ label: "Status", url: "https://status.example.test/" }] });
  } finally {
    interaction.close();
  }
  assert.match(output.text(), /1\. One/u);
  assert.match(output.text(), /2\. Two — Second/u);
  assert.match(output.text(), /accounts\.example\.test\/login/u);
  assert.match(output.text(), /enter code ABCD/u);
  assert.match(output.text(), /Status: https:\/\/status\.example\.test\//u);
});

test("the packed models package declares an executable rigyn-models bin", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
  };
  assert.deepEqual(manifest.bin, { "rigyn-models": "./dist/cli-bin.js" });
  assert.ok(manifest.files?.includes("dist"));
  assert.match(manifest.scripts?.["build:offline"] ?? "", /prepare-cli/u);
  assert.match(await readFile(new URL("../src/cli-bin.ts", import.meta.url), "utf8"), /^#!\/usr\/bin\/env node\n/u);
});
