import assert from "node:assert/strict";
import test from "node:test";

import { loginInteractively } from "../../src/cli/main.js";
import type { LoadedRuntime } from "../../src/cli/runtime.js";
import { TuiController } from "../../src/tui/controller.js";
import { FakeInput, FakeOutput } from "../tui/helpers.js";

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
    auth: {
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
