import assert from "node:assert/strict";
import test from "node:test";

import { loginInteractively } from "../../src/cli/main.js";
import type { LoadedRuntime } from "../../src/cli/runtime.js";
import { TuiController } from "../../src/tui/controller.js";
import { FakeInput, FakeOutput } from "../tui/helpers.js";

function fakeLogin(input: {
  methods: Array<Record<string, unknown>>;
  profiles?: Array<Record<string, unknown>>;
  choose?: (prompt: string, choices: Array<{ value: unknown }>) => unknown;
  question?: string;
  secret?: string;
}) {
  const state = {
    fallbacks: 0,
    notifications: [] as string[],
    selectedProfiles: [] as string[],
    stored: [] as Array<{ credential: unknown; options: unknown }>,
  };
  const runtime = {
    providers: { get: () => ({}), list: () => [{ id: "fixture" }] },
    modelRegistry: { models: () => ({ getProviders: () => [] }), getProvider: () => undefined, getProviderDisplayName: (provider: string) => provider },
    auth: {
      has: () => true,
      state: async () => ({ displayName: "Fixture provider", status: "disconnected" }),
      profileState: async () => ({
        activeProfile: "default",
        profiles: input.profiles ?? [],
      }),
      loginMethods: async () => input.methods,
      binding: () => ({ credentialId: "fixture-account" }),
      selectFallback: async () => { state.fallbacks += 1; },
      selectProfile: async (_provider: string, profile: string) => { state.selectedProfiles.push(profile); },
      storeCredential: async (_provider: string, credential: unknown, options: unknown) => {
        state.stored.push({ credential, options });
      },
    },
  } as unknown as LoadedRuntime;
  const terminal = {
    choose: async (prompt: string, choices: Array<{ value: unknown }>) =>
      input.choose?.(prompt, choices) ?? choices[0]!.value,
    question: async () => input.question ?? "",
    readSecret: async () => input.secret ?? "fixture-secret",
    notify: (message: string) => { state.notifications.push(message); },
  } as unknown as TuiController;
  return { runtime, terminal, state };
}

async function waitForOutput(output: FakeOutput, expected: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!output.text.includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function startLogin() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new TuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
  });
  terminal.start();

  const state = { storedCredentials: 0 };
  const runtime = {
    providers: { get: () => ({}) },
    modelRegistry: { models: () => ({ getProviders: () => [] }), getProvider: () => undefined, getProviderDisplayName: (provider: string) => provider },
    auth: {
      has: () => true,
      profileState: async () => { throw new Error("no saved profiles"); },
      loginMethods: async () => [{
        id: "api_key",
        kind: "api_key",
        label: "API key",
        detail: "Secure store",
      }],
      binding: () => ({ credentialId: "corp-account" }),
      storeCredential: async () => { state.storedCredentials += 1; },
    },
  } as unknown as LoadedRuntime;
  const controller = new AbortController();
  const login = loginInteractively(runtime, terminal, "corp", controller.signal);
  return { input, output, terminal, state, controller, login };
}

async function rejectsPromptly(login: Promise<string>, message: RegExp): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await assert.rejects(Promise.race([
      login,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("credential login did not cancel promptly")), 250);
      }),
    ]), message);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

test("interactive API-key login aborts a pending secret prompt without storing a credential", async () => {
  const fixture = startLogin();

  try {
    await waitForOutput(fixture.output, "corp API key: ");
    fixture.controller.abort(new Error("credential login cancelled"));
    await rejectsPromptly(fixture.login, /credential login cancelled/u);
    assert.equal(fixture.state.storedCredentials, 0);
  } finally {
    fixture.terminal.close();
    await fixture.login.catch(() => undefined);
  }
});

test("Escape cancels interactive API-key input without storing partial secret content", async () => {
  const fixture = startLogin();

  try {
    await waitForOutput(fixture.output, "corp API key: ");
    fixture.input.write(Buffer.concat([Buffer.from("partial-secret"), Buffer.from([27])]));
    await rejectsPromptly(fixture.login, /Secret input cancelled/u);
    assert.equal(fixture.state.storedCredentials, 0);
    assert.doesNotMatch(fixture.output.text, /partial-secret/u);
  } finally {
    fixture.terminal.close();
    await fixture.login.catch(() => undefined);
  }
});

test("interactive login handles provider-managed and fallback credential methods", async (t) => {
  for (const kind of ["local", "external"] as const) {
    await t.test(kind, async () => {
      const fixture = fakeLogin({ methods: [{ id: kind, kind, label: kind, detail: `${kind} managed` }] });
      assert.equal(await loginInteractively(fixture.runtime, fixture.terminal, "fixture"), "fixture");
      assert.deepEqual(fixture.state.notifications, [`${kind} managed`]);
      assert.equal(fixture.state.fallbacks, 0);
    });
  }
  for (const kind of ["environment", "ambient"] as const) {
    await t.test(kind, async () => {
      const fixture = fakeLogin({ methods: [{ id: kind, kind, label: kind, detail: `${kind} identity` }] });
      assert.equal(await loginInteractively(fixture.runtime, fixture.terminal, "fixture"), "fixture");
      assert.equal(fixture.state.fallbacks, 1);
      assert.deepEqual(fixture.state.stored, []);
    });
  }
});

test("interactive login stores API-key and bearer credentials with their provider binding", async (t) => {
  for (const kind of ["api_key", "bearer"] as const) {
    await t.test(kind, async () => {
      const fixture = fakeLogin({
        methods: [{ id: kind, kind, label: kind, detail: `${kind} credential` }],
        secret: `${kind}-secret`,
      });
      assert.equal(await loginInteractively(fixture.runtime, fixture.terminal, "fixture"), "fixture");
      assert.deepEqual(fixture.state.stored, [{
        credential: kind === "api_key"
          ? { kind: "api_key", provider: "fixture-account", apiKey: "api_key-secret" }
          : { kind: "bearer", provider: "fixture-account", accessToken: "bearer-secret" },
        options: {},
      }]);
    });
  }
});

test("interactive login reuses or creates isolated credential profiles", async () => {
  const saved = fakeLogin({
    methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
    profiles: [{ name: "work", active: false, present: true, usable: true }],
  });
  assert.equal(await loginInteractively(saved.runtime, saved.terminal, "fixture"), "fixture");
  assert.deepEqual(saved.state.selectedProfiles, ["work"]);
  assert.deepEqual(saved.state.stored, []);

  const created = fakeLogin({
    methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
    profiles: [{ name: "old", active: false, present: false, usable: false, error: "expired" }],
    choose: (prompt, choices) => prompt.startsWith("Credential profile")
      ? choices.at(-1)!.value
      : choices[0]!.value,
    question: "new-profile",
  });
  assert.equal(await loginInteractively(created.runtime, created.terminal, "fixture"), "fixture");
  assert.deepEqual(created.state.stored.map((entry) => entry.options), [{ profile: "new-profile", select: true }]);
});

test("interactive login rejects providers without a usable method or an empty secret", async () => {
  const unavailable = fakeLogin({ methods: [] });
  await assert.rejects(
    loginInteractively(unavailable.runtime, unavailable.terminal, "fixture"),
    /does not expose an interactive login method/u,
  );
  const empty = fakeLogin({
    methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
    secret: "",
  });
  await assert.rejects(loginInteractively(empty.runtime, empty.terminal, "fixture"), /Credential is empty/u);
});

test("interactive login discovers providers after the operator selects an authentication path", async () => {
  const fixture = fakeLogin({
    methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "stored" }],
    choose: (prompt, choices) => prompt === "Select authentication method"
      ? choices.at(-1)!.value
      : choices[0]!.value,
  });
  assert.equal(await loginInteractively(fixture.runtime, fixture.terminal), "fixture");
  assert.equal(fixture.state.stored.length, 1);
});
