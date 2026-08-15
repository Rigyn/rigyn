import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  configuredOAuthClientId,
  DEFAULT_OAUTH_CLIENT_IDS,
} from "../../src/auth/oauth-client-registration.js";
import { pinnedBuiltinOAuthRefreshCredential } from "../../src/auth/builtin-oauth-refresh.js";
import { kimiCodeOAuthRegistration } from "../../src/auth/kimi-code.js";
import { xaiOAuthRegistration } from "../../src/auth/xai.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const textExtensions = new Set([".c", ".h", ".js", ".json", ".md", ".mjs", ".mm", ".rs", ".swift", ".ts", ".tsx"]);

async function textFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return textExtensions.has(extname(path)) || path.endsWith("README.md") ? [path] : [];
  const children = await readdir(path);
  return (await Promise.all(children.map(async (name) => await textFiles(join(path, name))))).flat();
}

const forgedUpstreamIdentity = new RegExp(
  `["']?(?:${["origi", "nator"].join("")}|${["refer", "rer"].join("")})["']?\\s*:\\s*["']${["p", "i"].join("")}["']`,
  "iu",
);

async function forbiddenFiles(roots: readonly string[]): Promise<string[]> {
  const files = (await Promise.all(roots.map(async (root) => await textFiles(join(packageRoot, root))))).flat();
  const matches: string[] = [];
  for (const file of files) {
    const value = await readFile(file, "utf8");
    if (forgedUpstreamIdentity.test(value)) {
      matches.push(relative(packageRoot, file));
    }
  }
  return matches.sort();
}

test("OAuth client IDs have built-in public defaults and bounded provider-specific overrides", () => {
  assert.equal(configuredOAuthClientId("xai", {}), DEFAULT_OAUTH_CLIENT_IDS.xai);
  assert.equal(
    configuredOAuthClientId("xai", { RIGYN_XAI_OAUTH_CLIENT_ID: "rigyn-xai-test-client" }),
    "rigyn-xai-test-client",
  );
  assert.throws(
    () => configuredOAuthClientId("xai", { RIGYN_XAI_OAUTH_CLIENT_ID: " xai-client " }),
    /1 through 512 visible ASCII/u,
  );
  assert.throws(
    () => configuredOAuthClientId("xai", { RIGYN_XAI_OAUTH_CLIENT_ID: "x".repeat(513) }),
    /1 through 512 visible ASCII/u,
  );
  assert.equal(configuredOAuthClientId("openai-codex", {}), DEFAULT_OAUTH_CLIENT_IDS["openai-codex"]);
  assert.equal(configuredOAuthClientId("anthropic", {}), DEFAULT_OAUTH_CLIENT_IDS.anthropic);
  assert.equal(configuredOAuthClientId("github-copilot", {}), DEFAULT_OAUTH_CLIENT_IDS["github-copilot"]);
  assert.equal(configuredOAuthClientId("kimi-code", {}), DEFAULT_OAUTH_CLIENT_IDS["kimi-code"]);
  assert.equal(
    configuredOAuthClientId("kimi-code", { RIGYN_KIMI_CODE_OAUTH_CLIENT_ID: "rigyn-kimi-test-client" }),
    "rigyn-kimi-test-client",
  );
});

test("Kimi Code registration exposes its bounded public device flow", () => {
  const registration = kimiCodeOAuthRegistration("rigyn-kimi-test-client");
  assert.deepEqual(registration, {
    provider: "kimi-code",
    flow: "device",
    clientId: "rigyn-kimi-test-client",
    deviceEndpoint: "https://auth.kimi.com/api/oauth/device_authorization",
    tokenEndpoint: "https://auth.kimi.com/api/oauth/token",
    scopes: [],
    label: "Sign in with Kimi Code",
    requireRefreshToken: true,
  });
});

test("xAI registration uses official discovery endpoints without invented device parameters", () => {
  const registration = xaiOAuthRegistration("rigyn-xai-test-client");
  assert.equal(registration.flow, "device");
  if (registration.flow !== "device") assert.fail("Expected a device registration");
  assert.equal(registration.deviceEndpoint, "https://auth.x.ai/oauth2/device/code");
  assert.equal(registration.tokenEndpoint, "https://auth.x.ai/oauth2/token");
  assert.equal(registration.clientId, "rigyn-xai-test-client");
  assert.equal(registration.deviceParameters, undefined);
  assert.equal(registration.requireRefreshToken, true);
  assert.ok(registration.scopes.includes("api:access"));
  assert.equal(registration.scopes.some((scope) => scope.includes("cli")), false);
});

test("built-in device refresh metadata is pinned independently of stored values", () => {
  const stored = {
    kind: "oauth" as const,
    provider: "kimi-code",
    accessToken: "expired-access",
    refreshToken: "stored-refresh",
    expiresAt: 1,
    tokenType: "Bearer",
    scopes: [],
    tokenEndpoint: "https://attacker.invalid/token",
    clientId: "attacker-client",
  };
  assert.deepEqual(pinnedBuiltinOAuthRefreshCredential("kimi-code", stored, {
    RIGYN_KIMI_CODE_OAUTH_CLIENT_ID: "trusted-kimi-client",
  }), {
    ...stored,
    tokenEndpoint: "https://auth.kimi.com/api/oauth/token",
    clientId: "trusted-kimi-client",
  });
  assert.equal(
    pinnedBuiltinOAuthRefreshCredential("xai", { ...stored, provider: "xai" }, {
      RIGYN_XAI_OAUTH_CLIENT_ID: "trusted-xai-client",
    }).tokenEndpoint,
    "https://auth.x.ai/oauth2/token",
  );
});

test("repository auth surfaces contain no forged upstream request identity", async () => {
  assert.deepEqual(await forbiddenFiles([
    "src",
    "test",
    "docs",
    "release",
    "scripts",
    "README.md",
    "package.json",
    "../terminal/native",
  ]), []);
});

test("compiled auth surfaces contain no forged upstream request identity", async () => {
  assert.deepEqual(await forbiddenFiles(["dist"]), []);
});
