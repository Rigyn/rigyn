import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { amazonBedrockProvider } from "../src/bedrock-provider.js";
import { registerBunOAuthFlows } from "../src/bun-oauth.js";
import * as compatibility from "../src/compat.js";
import { generatePKCE, pollOAuthDeviceCodeFlow } from "../src/oauth.js";
import {
  loadAnthropicOAuth,
  loadGitHubCopilotOAuth,
  loadOpenAICodexOAuth,
  loadXaiOAuth,
} from "../src/auth/oauth/load.js";

test("bundled OAuth entry installs executable lazy loaders", async () => {
  registerBunOAuthFlows();
  const methods = await Promise.all([
    loadAnthropicOAuth(),
    loadGitHubCopilotOAuth(),
    loadOpenAICodexOAuth(),
    loadXaiOAuth(),
  ]);
  for (const method of methods) {
    assert.equal(typeof method.name, "string");
    assert.equal(typeof method.login, "function");
    assert.equal(typeof method.refresh, "function");
    assert.equal(typeof method.toAuth, "function");
  }

  const pair = await generatePKCE();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/u);

  const provider = amazonBedrockProvider();
  assert.equal(provider.id, "amazon-bedrock");
  assert.deepEqual(provider.getModels(), []);
  assert.equal(typeof provider.stream, "function");
});

test("root and compatibility entries share executable model semantics", async () => {
  const registration = compatibility.registerFauxProvider({
    provider: "public-entry",
    models: [{ id: "entry-model" }],
  });
  try {
    registration.setResponses([compatibility.fauxAssistantMessage("ready")]);
    const message = await compatibility.complete(registration.getModel(), { messages: [] });
    assert.equal(compatibility.contentText(message.content), "ready");
  } finally {
    registration.unregister();
  }

  let polls = 0;
  const deviceResult = await pollOAuthDeviceCodeFlow({
    async poll() {
      polls += 1;
      return { status: "complete", value: "authorized" } as const;
    },
  });
  assert.equal(deviceResult, "authorized");
  assert.equal(polls, 1);
});

test("manifest metadata matches the public runtime", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    name?: unknown;
    version?: unknown;
    type?: unknown;
  };
  assert.equal(manifest.name, "@rigyn/models");
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/u);
  assert.equal(manifest.type, "module");
});
