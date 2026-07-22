import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTHROPIC_SUBSCRIPTION_AUTH_WARNING,
  AnthropicSubscriptionWarning,
} from "../../src/interactive/anthropic-warning.js";

function authModels(type: "api_key" | "oauth" | undefined, apiKey?: string) {
  return {
    async checkAuth() { return type === undefined ? undefined : { type }; },
    async getAuth() { return apiKey === undefined ? undefined : { auth: { apiKey } }; },
  };
}

test("Anthropic subscription warning is shown once for OAuth", async () => {
  const warning = new AnthropicSubscriptionWarning();
  const messages: string[] = [];
  const options = {
    enabled: true,
    model: { provider: "anthropic" },
    models: authModels("oauth"),
    notify(message: string) { messages.push(message); },
  };

  assert.equal(await warning.maybeNotify(options), true);
  assert.equal(await warning.maybeNotify(options), false);
  assert.deepEqual(messages, [ANTHROPIC_SUBSCRIPTION_AUTH_WARNING]);
});

test("Anthropic subscription warning recognizes OAuth API keys", async () => {
  const warning = new AnthropicSubscriptionWarning();
  const messages: string[] = [];
  assert.equal(await warning.maybeNotify({
    enabled: true,
    model: { provider: "anthropic" },
    models: authModels("api_key", "sk-ant-oat-fixture"),
    notify(message) { messages.push(message); },
  }), true);
  assert.equal(messages.length, 1);
});

test("Anthropic subscription warning ignores disabled, unrelated, standard, and failed auth", async () => {
  const cases = [
    { enabled: false, model: { provider: "anthropic" }, models: authModels("oauth") },
    { enabled: true, model: { provider: "openai" }, models: authModels("oauth") },
    { enabled: true, model: { provider: "anthropic" }, models: authModels("api_key", "sk-ant-api-fixture") },
    {
      enabled: true,
      model: { provider: "anthropic" },
      models: {
        async checkAuth(): Promise<never> { throw new Error("fixture auth failure"); },
        async getAuth(): Promise<undefined> { return undefined; },
      },
    },
  ];
  for (const options of cases) {
    const warning = new AnthropicSubscriptionWarning();
    let notified = false;
    assert.equal(await warning.maybeNotify({ ...options, notify() { notified = true; } }), false);
    assert.equal(notified, false);
  }
});
