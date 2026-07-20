import assert from "node:assert/strict";
import test from "node:test";

import type { OAuthCredential, ProviderManagedAuthInteraction } from "../../src/auth/index.js";
import { loginInteractively } from "../../src/cli/main.js";
import type { LoadedRuntime } from "../../src/cli/runtime.js";
import type { TuiController } from "../../src/tui/controller.js";

function credential(): OAuthCredential {
  return {
    kind: "oauth",
    provider: "managed-account",
    accessToken: "managed-access",
    refreshToken: "managed-refresh",
    expiresAt: Date.now() + 60_000,
    tokenType: "Bearer",
    scopes: ["models.read"],
    providerData: { managedFlow: "subscription" },
  };
}

function fixture(
  authorize: (interaction: ProviderManagedAuthInteraction) => Promise<OAuthCredential>,
) {
  const state = {
    notifications: [] as string[],
    questions: [] as string[],
    choices: [] as Array<{ message: string; values: unknown[] }>,
    stored: [] as Array<{ provider: string; credential: unknown; options: unknown }>,
  };
  const runtime = {
    providers: { get: () => ({}) },
    auth: {
      profileState: async () => { throw new Error("no saved profiles"); },
      loginMethods: async () => [{
        id: "managed:subscription",
        kind: "managed_oauth",
        label: "Managed subscription",
        detail: "Provider-owned sign-in",
        methodId: "subscription",
      }],
      binding: () => ({ credentialId: "managed-account" }),
      authorizeManaged: async (
        provider: string,
        methodId: string,
        interaction: ProviderManagedAuthInteraction,
      ) => {
        assert.equal(provider, "managed-provider");
        assert.equal(methodId, "subscription");
        return await authorize(interaction);
      },
      storeCredential: async (provider: string, value: unknown, options: unknown) => {
        state.stored.push({ provider, credential: value, options });
      },
    },
  } as unknown as LoadedRuntime;
  const terminal = {
    notify(message: string) { state.notifications.push(message); },
    async question(message: string) {
      state.questions.push(message);
      return "manual-answer";
    },
    async choose(message: string, options: Array<{ value: unknown }>) {
      state.choices.push({ message, values: options.map((option) => option.value) });
      return message === "Choose an account" ? options.at(-1)!.value : options[0]!.value;
    },
    async readSecret() { throw new Error("managed login must not request a raw secret"); },
  } as unknown as TuiController;
  return { runtime, terminal, state };
}

test("interactive managed login bridges provider-owned prompts and stores only normalized credentials", async () => {
  const returnedCredential = credential();
  const fixtureValue = fixture(async (interaction) => {
    assert.equal(interaction.signal.aborted, false);
    await interaction.showAuthorization({ url: "https://identity.example.test/authorize" });
    await interaction.showDeviceCode({
      userCode: "ABCD-1234",
      verificationUri: new URL("https://identity.example.test/device"),
      intervalSeconds: 2,
      expiresInSeconds: 300,
    });
    await interaction.showProgress("Waiting for provider approval");
    assert.equal(await interaction.prompt({ message: "Paste the confirmation code: " }), "manual-answer");
    assert.equal(await interaction.select({
      message: "Choose an account",
      options: [
        { id: "personal", label: "Personal" },
        { id: "work", label: "Work", detail: "Managed tenant" },
      ],
    }), "work");
    return returnedCredential;
  });

  const controller = new AbortController();
  assert.equal(await loginInteractively(
    fixtureValue.runtime,
    fixtureValue.terminal,
    "managed-provider",
    controller.signal,
    true,
  ), "managed-provider");
  assert.deepEqual(fixtureValue.state.notifications, [
    "Open this URL to sign in:\nhttps://identity.example.test/authorize",
    "Open https://identity.example.test/device and enter code ABCD-1234\nWaiting for authentication...",
    "Waiting for provider approval",
  ]);
  assert.deepEqual(fixtureValue.state.questions, ["Paste the confirmation code: "]);
  assert.deepEqual(fixtureValue.state.choices, [{
    message: "Choose an account",
    values: ["personal", "work"],
  }]);
  assert.deepEqual(fixtureValue.state.stored, [{
    provider: "managed-provider",
    credential: returnedCredential,
    options: {},
  }]);
});

test("interactive managed login rejects unsafe provider interaction output before storage", async () => {
  const fixtureValue = fixture(async (interaction) => {
    await interaction.showAuthorization({ url: "http://identity.example.test/authorize" });
    return credential();
  });
  await assert.rejects(
    loginInteractively(fixtureValue.runtime, fixtureValue.terminal, "managed-provider", undefined, true),
    /authorization URL is invalid/u,
  );
  assert.deepEqual(fixtureValue.state.stored, []);
  assert.deepEqual(fixtureValue.state.notifications, []);
});
