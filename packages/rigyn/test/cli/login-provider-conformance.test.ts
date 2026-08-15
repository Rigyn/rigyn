import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_ENVIRONMENT_CREDENTIALS,
  environmentCredentialVariables,
} from "../../src/auth/broker.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import type { ExtensionMode } from "../../src/extensions/capabilities/host.js";
import { builtinProviders } from "../../src/providers/all.js";
import { canonicalProviderId } from "../../src/providers/builtins.js";
import { providerLoginMethods } from "../../src/providers/login-path.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

const MODES = ["tui", "print", "json", "rpc", "serve", "sdk"] as const satisfies readonly ExtensionMode[];
const PROVIDERS = [
  "anthropic",
  "deepseek",
  "github-copilot",
  "google",
  "kimi-code",
  "ollama",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "xai",
] as const;
const SUBSCRIPTION_PROVIDERS = [
  "anthropic",
  "github-copilot",
  "kimi-code",
  "openai-codex",
  "openrouter",
  "xai",
] as const;
const SUBSCRIPTION_KINDS = new Set([
  "anthropic_browser",
  "github_copilot_device",
  "managed_oauth",
  "oauth",
  "openai_codex_browser",
  "openai_codex_device",
  "openrouter_browser",
]);

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function configuredCredentialEnvironment(configured: boolean): void {
  for (const spec of Object.values(DEFAULT_ENVIRONMENT_CREDENTIALS)) {
    for (const variable of environmentCredentialVariables(spec)) delete process.env[variable];
  }
  if (configured) for (const spec of Object.values(DEFAULT_ENVIRONMENT_CREDENTIALS)) {
    process.env[spec.variable] = `configured-${spec.variable.toLowerCase()}`;
  }
}

test("/login and direct provider identities stay aligned in every mode with empty and configured environments", {
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-login-provider-conformance-"));
  const credentialVariables = sorted(new Set(Object.values(DEFAULT_ENVIRONMENT_CREDENTIALS)
    .flatMap((spec) => environmentCredentialVariables(spec))));
  const previousEnvironment = new Map(credentialVariables.map((name) => [name, process.env[name]]));
  try {
    for (const configured of [false, true]) {
      configuredCredentialEnvironment(configured);
      for (const mode of MODES) {
        const workspace = join(root, configured ? "configured" : "empty", mode, "workspace");
        const agentDirectory = join(root, configured ? "configured" : "empty", mode, "agent");
        await mkdir(workspace, { recursive: true });
        const runtime = await loadRuntime({
          workspace,
          agentDirectory,
          credentialStore: new InMemoryCredentialStore(),
          projectTrusted: false,
          ephemeral: true,
          extensions: false,
          extensionRuntime: true,
          skills: false,
          promptTemplates: false,
          themes: false,
          offline: true,
          deferModelNetworkRefresh: true,
        });
        let closed = false;
        try {
          await runtime.session.bindExtensions({ mode });
          const legacyIds = sorted(runtime.auth.providers().map((entry) => canonicalProviderId(entry.providerId)));
          const runtimeDirectIds = sorted(runtime.modelRegistry.models().getProviders()
            .map((entry) => canonicalProviderId(entry.id)));
          const standalone = builtinProviders(process.env);
          const standaloneIds = sorted(standalone.map((entry) => canonicalProviderId(entry.id)));
          assert.deepEqual(legacyIds, [...PROVIDERS], `${mode}/${configured}: legacy`);
          assert.deepEqual(runtimeDirectIds, legacyIds, `${mode}/${configured}: runtime direct`);
          assert.deepEqual(standaloneIds, legacyIds, `${mode}/${configured}: standalone direct`);

          const legacySubscriptionMethods = Object.fromEntries((await Promise.all(runtime.auth.providers().map(async (entry) => [
            canonicalProviderId(entry.providerId),
            (await runtime.auth.loginMethods(entry.providerId))
              .filter((method) => SUBSCRIPTION_KINDS.has(method.kind))
              .map((method) => method.id),
          ] as const))).filter(([, methods]) => methods.length > 0));
          assert.deepEqual(sorted(Object.keys(legacySubscriptionMethods)), [...SUBSCRIPTION_PROVIDERS]);
          assert.deepEqual(legacySubscriptionMethods, {
            anthropic: ["anthropic_browser"],
            "github-copilot": ["github_copilot_device"],
            "kimi-code": ["oauth:rigyn.kimi-code.account"],
            "openai-codex": ["openai_codex_browser", "openai_codex_device"],
            openrouter: ["openrouter_browser"],
            xai: ["oauth:rigyn.xai.subscription"],
          });

          const directSubscriptionMethods = Object.fromEntries(standalone.flatMap((provider) => {
            const methods = providerLoginMethods(provider.auth).filter((method) => method.path === "subscription");
            return methods.length === 0 ? [] : [[provider.id, methods.map((method) => method.type)]];
          }));
          assert.deepEqual(sorted(Object.keys(directSubscriptionMethods)), [...SUBSCRIPTION_PROVIDERS]);
          assert.deepEqual(directSubscriptionMethods, {
            anthropic: ["oauth"],
            "github-copilot": ["oauth"],
            "kimi-code": ["oauth"],
            "openai-codex": ["oauth"],
            openrouter: ["provider_account"],
            xai: ["oauth"],
          });

          const runtimeDirectSubscriptionMethods = Object.fromEntries(
            runtime.modelRegistry.models().getProviders().flatMap((provider) => {
              const methods = providerLoginMethods(provider.auth).filter((method) => method.path === "subscription");
              return methods.length === 0
                ? []
                : [[canonicalProviderId(provider.id), methods.map((method) => method.type)]];
            }),
          );
          assert.deepEqual(runtimeDirectSubscriptionMethods, directSubscriptionMethods);
          assert.deepEqual(sorted(Object.keys(runtimeDirectSubscriptionMethods)), sorted(Object.keys(legacySubscriptionMethods)));

          const environmentProviders = (await Promise.all(runtime.auth.providers().map(async (entry) => [
            entry.providerId,
            (await runtime.auth.loginMethods(entry.providerId)).some((method) => method.kind === "environment"),
          ] as const))).filter(([, present]) => present).map(([provider]) => provider);
          assert.deepEqual(sorted(environmentProviders), configured
            ? [
                "anthropic", "deepseek", "gemini", "github-copilot", "kimi-code",
                "openai", "opencode", "opencode-go", "openrouter", "xai",
              ]
            : []);
          assert.deepEqual(
            (await runtime.auth.loginMethods("kimi-code")).map((method) => method.kind),
            configured ? ["oauth", "environment", "api_key"] : ["oauth", "api_key"],
          );
          assert.deepEqual(
            providerLoginMethods(standalone.find((provider) => provider.id === "kimi-code")!.auth)
              .map((method) => [method.type, method.path]),
            [["oauth", "subscription"], ["api_key", "api_key"]],
          );

          const accountProviders = runtime.modelRegistry.models().getProviders()
            .filter((provider) => SUBSCRIPTION_PROVIDERS.includes(canonicalProviderId(provider.id) as typeof SUBSCRIPTION_PROVIDERS[number]));
          await runtime.close();
          closed = true;
          for (const provider of accountProviders) {
            const login = provider.auth.providerAccount?.login ?? provider.auth.oauth?.login;
            assert.ok(login, provider.id);
            await assert.rejects(login({
              notify() {},
              async prompt(prompt) {
                prompt.signal?.throwIfAborted();
                throw new Error("login prompt unexpectedly survived runtime closure");
              },
            }), /closed|abort|resource generation/u, provider.id);
          }
        } finally {
          if (!closed) await runtime.close();
        }
      }
    }
  } finally {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
