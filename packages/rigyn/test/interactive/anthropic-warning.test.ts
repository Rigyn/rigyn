import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTHROPIC_API_BEARER_BILLING_WARNING,
  ANTHROPIC_OAUTH_BILLING_WARNING,
  AnthropicApiBearerBillingWarning,
} from "../../src/interactive/anthropic-warning.js";

function authModels(type: "api_key" | "oauth" | undefined, apiKey?: string, authorization?: string) {
  return {
    async checkAuth() { return type === undefined ? undefined : { type }; },
    async getAuth() {
      return apiKey === undefined && authorization === undefined
        ? undefined
        : { auth: { ...(apiKey === undefined ? {} : { apiKey }), ...(authorization === undefined ? {} : { headers: { Authorization: authorization } }) } };
    },
  };
}

test("Anthropic API billing warning is shown once for bearer-like saved auth", async () => {
  const warning = new AnthropicApiBearerBillingWarning();
  const messages: string[] = [];
  const options = {
    enabled: true,
    model: { provider: "anthropic" },
    models: authModels("api_key", "sk-ant-oat-fixture"),
    notify(message: string) { messages.push(message); },
  };

  assert.equal(await warning.maybeNotify(options), true);
  assert.equal(await warning.maybeNotify(options), false);
  assert.deepEqual(messages, [ANTHROPIC_API_BEARER_BILLING_WARNING]);
});

test("Anthropic API billing warning recognizes Console bearer tokens", async () => {
  const warning = new AnthropicApiBearerBillingWarning();
  const messages: string[] = [];
  assert.equal(await warning.maybeNotify({
    enabled: true,
    model: { provider: "anthropic" },
    models: authModels("api_key", undefined, "Bearer console-token"),
    notify(message) { messages.push(message); },
  }), true);
  assert.equal(messages.length, 1);
});

test("Anthropic OAuth warning states that eligibility and billing remain provider decisions", async () => {
  const warning = new AnthropicApiBearerBillingWarning();
  const messages: string[] = [];
  assert.equal(await warning.maybeNotify({
    enabled: true,
    model: { provider: "anthropic" },
    models: authModels("oauth"),
    notify(message) { messages.push(message); },
  }), true);
  assert.deepEqual(messages, [ANTHROPIC_OAUTH_BILLING_WARNING]);
  assert.match(messages[0]!, /eligib|billing/iu);
});

test("Anthropic subscription warning ignores disabled, unrelated, standard, and failed auth", async () => {
  const cases = [
    { enabled: false, model: { provider: "anthropic" }, models: authModels("api_key", "sk-ant-oat-fixture") },
    { enabled: true, model: { provider: "openai" }, models: authModels("api_key", "sk-ant-oat-fixture") },
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
    const warning = new AnthropicApiBearerBillingWarning();
    let notified = false;
    assert.equal(await warning.maybeNotify({ ...options, notify() { notified = true; } }), false);
    assert.equal(notified, false);
  }
});
