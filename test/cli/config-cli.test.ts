import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArguments } from "../../src/cli/args.js";
import { parseHarnessConfig } from "../../src/config/schema.js";
import { TrustStore } from "../../src/config/trust.js";
import { defaultTools, selectedTools } from "../../src/cli/main.js";

test("CLI parser separates commands, flags, and literal prompts", () => {
  const parsed = parseArguments(["--provider", "openai", "--model=gpt", "--", "--literal prompt"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.flags.get("provider"), "openai");
  assert.equal(parsed.flags.get("model"), "gpt");
  assert.deepEqual(parsed.positionals, ["--literal prompt"]);
});

test("-p selects non-interactive print mode while providers remain explicit", () => {
  const printed = parseArguments(["-p", "summarize this"]);
  assert.equal(printed.command, "run");
  assert.equal(printed.flags.get("print"), true);
  assert.equal(printed.flags.has("provider"), false);
  assert.deepEqual(printed.positionals, ["summarize this"]);

  const provider = parseArguments(["--provider", "openai", "hello"]);
  assert.equal(provider.flags.get("provider"), "openai");
});

test("project trust overrides and the short session-name flag parse without changing persistence", () => {
  const approved = parseArguments(["--approve", "-n", "review"]);
  assert.equal(approved.flags.get("approve"), true);
  assert.equal(approved.flags.get("name"), "review");
  assert.equal(parseArguments(["--no-approve", "hello"]).flags.get("no-approve"), true);
  assert.equal(parseArguments(["--fork", "source-session"]).flags.get("fork"), "source-session");
});

test("CLI parser rejects unknown and duplicate flags", () => {
  assert.throws(() => parseArguments(["--modle", "gpt", "hello"]), /Unknown flag --modle/u);
  assert.throws(() => parseArguments(["--model", "one", "--model", "two", "hello"]), /more than once/u);
});

test("CLI parser accepts coding-tool selection", () => {
  const selected = parseArguments(["--tools", "read,write,edit,bash", "hello"]);
  assert.equal(selected.flags.get("tools"), "read,write,edit,bash");
  assert.equal(parseArguments(["--all-tools"]).flags.get("all-tools"), true);
  assert.equal(parseArguments(["--no-tools"]).flags.get("no-tools"), true);
  assert.equal(parseArguments(["--no-builtin-tools"]).flags.get("no-builtin-tools"), true);
  assert.equal(parseArguments(["--no-context-files"]).flags.get("no-context-files"), true);
  assert.equal(parseArguments(["--exclude-tools", "grep"]).flags.get("exclude-tools"), "grep");
});

test("CLI parser preserves repeatable invocation-scoped extension paths", () => {
  const parsed = parseArguments([
    "--extension", "one.ts",
    "--extension=extensions/two",
    "--no-extensions",
    "hello",
  ]);
  assert.deepEqual(parsed.flags.get("extension"), ["one.ts", "extensions/two"]);
  assert.equal(parsed.flags.get("no-extensions"), true);
  assert.deepEqual(parsed.positionals, ["hello"]);
});

test("default model surface is the four core coding tools", () => {
  assert.deepEqual(defaultTools(), ["read", "write", "edit", "bash"]);
  assert.deepEqual(selectedTools(parseArguments(["hello"]), ["extension_echo"]), {
    allowedTools: ["read", "write", "edit", "bash", "extension_echo"],
  });
  assert.deepEqual(selectedTools(parseArguments(["--no-builtin-tools", "hello"]), ["extension_echo"]), {
    noBuiltinTools: true,
  });
  assert.deepEqual(selectedTools(parseArguments(["--tools", "read", "hello"]), ["extension_echo"]), {
    allowedTools: ["read"],
  });
  assert.equal(parseHarnessConfig({}).autoCompaction, true);
});

test("default project trust accepts only ask, always, or never", () => {
  assert.equal(parseHarnessConfig({}).defaultProjectTrust, "ask");
  assert.equal(parseHarnessConfig({ defaultProjectTrust: "always" }).defaultProjectTrust, "always");
  assert.equal(parseHarnessConfig({ defaultProjectTrust: "never" }).defaultProjectTrust, "never");
  assert.throws(
    () => parseHarnessConfig({ defaultProjectTrust: "sometimes" }),
    /defaultProjectTrust must be ask, always, or never/u,
  );
  assert.throws(
    () => parseHarnessConfig({ defaultProjectTrust: true }),
    /defaultProjectTrust must be a non-empty string/u,
  );
});

test("CLI parser recognizes package command surfaces", () => {
  assert.equal(parseArguments(["install", "/tmp/package"]).command, "install");
  assert.equal(parseArguments(["list", "--local"]).flags.get("local"), true);
});

test("typed config rejects unknown top-level keys", () => {
  const config = parseHarnessConfig({
    providers: {
      local: { kind: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1" },
      gateway: {
        kind: "openai-compatible",
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        profile: "vercel-ai-gateway",
      },
      mimo: {
        kind: "openai-compatible",
        baseUrl: "https://api.xiaomimimo.com/v1",
        profile: "xiaomi",
      },
      cloudflare: {
        kind: "openai-compatible",
        baseUrl: "https://gateway.example/v1",
        profile: "cloudflare-ai-gateway",
      },
      messages: {
        kind: "anthropic",
        id: "messages",
        credentialProvider: "messages",
        baseUrl: "https://messages.example/v1",
      },
      "llama.cpp": {
        kind: "llama-router",
        id: "llama.cpp",
        baseUrl: "https://router.example.test",
        credentialProvider: "local-router-token",
        timeoutMs: 2_500,
      },
      "company-gateway": {
        kind: "gateway-messages",
        gatewayUrl: "https://gateway.example.test/v1",
        credentialProvider: "company-login",
        cacheRetention: "long",
        toolChoice: "auto",
        temperature: 0.4,
      },
    },
  });
  assert.equal(config.providers.local?.kind, "openai-compatible");
  assert.deepEqual(config.providers.gateway, {
    kind: "openai-compatible",
    id: "gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    profile: "vercel-ai-gateway",
  });
  assert.deepEqual(config.providers.mimo, {
    kind: "openai-compatible",
    id: "mimo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    profile: "xiaomi",
  });
  assert.deepEqual(config.providers.cloudflare, {
    kind: "openai-compatible",
    id: "cloudflare",
    baseUrl: "https://gateway.example/v1",
    profile: "cloudflare-ai-gateway",
  });
  assert.deepEqual(config.providers.messages, {
    kind: "anthropic",
    id: "messages",
    credentialProvider: "messages",
    baseUrl: "https://messages.example/v1",
  });
  assert.deepEqual(config.providers["llama.cpp"], {
    kind: "llama-router",
    id: "llama.cpp",
    baseUrl: "https://router.example.test",
    credentialProvider: "local-router-token",
    timeoutMs: 2_500,
  });
  assert.deepEqual(config.providers["company-gateway"], {
    kind: "gateway-messages",
    id: "company-gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    credentialProvider: "company-login",
    cacheRetention: "long",
    toolChoice: "auto",
    temperature: 0.4,
  });
  assert.throws(() => parseHarnessConfig({
    providers: { "llama.cpp": { kind: "llama-router", id: "llama.cpp", timeoutMs: 120_001 } },
  }), /timeoutMs must not exceed 120000/u);
  assert.throws(() => parseHarnessConfig({
    providers: { custom: { kind: "openai-compatible", baseUrl: "https://example.test/v1", profile: "guess" } },
  }), /profile must be/u);
  assert.throws(() => parseHarnessConfig({
    providers: { gateway: { kind: "gateway-messages", gatewayUrl: "https://example.test/v1", temperature: 3 } },
  }), /temperature must be between 0 and 2/u);
  assert.throws(() => parseHarnessConfig({ typo: true }), /unknown keys/u);
});

test("routed provider configuration requires exact adapters, protocols, and optional static metadata", () => {
  const config = parseHarnessConfig({
    providers: {
      company: {
        kind: "routed",
        credentialProvider: "company-credential",
        adapters: {
          fast: { kind: "openai-compatible", baseUrl: "https://chat.example/v1" },
          deep: { kind: "anthropic", baseUrl: "https://messages.example/v1" },
        },
        routes: [{
          model: "fast-code",
          upstreamModel: "upstream-fast",
          adapter: "fast",
          protocolFamily: "openai-chat-completions",
          modelInfo: {
            displayName: "Fast Code",
            contextTokens: 131_072,
            tools: true,
            reasoningEfforts: ["off", "high"],
          },
        }, {
          model: "deep-code",
          adapter: "deep",
          protocolFamily: "anthropic-messages",
        }],
      },
    },
  });
  const routed = config.providers.company;
  assert.equal(routed?.kind, "routed");
  if (routed?.kind !== "routed") throw new Error("Expected routed provider configuration");
  assert.equal(routed.id, "company");
  assert.equal(routed.credentialProvider, "company-credential");
  assert.equal(routed.routes[0]?.modelInfo?.displayName, "Fast Code");
  assert.equal(routed.routes[0]?.modelInfo?.compatibility?.protocolFamily?.value, "openai-chat-completions");
  assert.throws(() => parseHarnessConfig({
    providers: {
      company: {
        kind: "routed",
        adapters: { nested: { kind: "routed", adapters: {}, routes: [] } },
        routes: [{ model: "bad", adapter: "nested", protocolFamily: "openai-responses" }],
      },
    },
  }), /cannot contain a nested routed provider/u);
  assert.throws(() => parseHarnessConfig({
    providers: {
      company: {
        kind: "routed",
        adapters: { fast: { kind: "openai-compatible", baseUrl: "https://chat.example/v1" } },
        routes: [{ model: "bad", adapter: "fast", protocolFamily: "guessed-protocol" }],
      },
    },
  }), /protocolFamily is unsupported/u);
  assert.throws(() => parseHarnessConfig({
    providers: {
      company: {
        kind: "routed",
        adapters: { fast: { kind: "openai-compatible", baseUrl: "https://chat.example/v1" } },
        routes: [{
          model: "bad",
          adapter: "fast",
          protocolFamily: "openai-chat-completions",
          modelInfo: { id: "shadowed-id" },
        }],
      },
    },
  }), /modelInfo contains unknown keys: id/u);
});

test("declarative model metadata is exact, bounded, and closed", () => {
  const config = parseHarnessConfig({
    models: [{
      provider: "catalog",
      id: "org/coder:preview@2026",
      displayName: "Configured Coder",
      description: "Offline catalog entry",
      contextTokens: 131_072,
      maxOutputTokens: 8_192,
      tools: true,
      reasoningEfforts: ["off", "low", "high"],
      images: false,
      pricing: { input: 1.25, output: 5, cacheRead: 0.25 },
    }],
  });
  assert.deepEqual(config.models, [{
    provider: "catalog",
    id: "org/coder:preview@2026",
    displayName: "Configured Coder",
    description: "Offline catalog entry",
    contextTokens: 131_072,
    maxOutputTokens: 8_192,
    tools: true,
    images: false,
    reasoningEfforts: ["off", "low", "high"],
    pricing: { input: 1.25, output: 5, cacheRead: 0.25 },
  }]);
  assert.throws(() => parseHarnessConfig({ models: [
    { provider: "catalog", id: "same" },
    { provider: "catalog", id: "same" },
  ] }), /duplicated/u);
  assert.throws(() => parseHarnessConfig({ models: [{ provider: "catalog", id: "model", typo: true }] }), /unknown fields/u);
  assert.throws(() => parseHarnessConfig({ models: [{ provider: "catalog", id: " model " }] }), /surrounding whitespace/u);
  assert.throws(() => parseHarnessConfig({ models: [{ provider: "catalog", id: "model", description: "x".repeat(4_097) }] }), /too long/u);
  assert.throws(() => parseHarnessConfig({ models: [{ provider: "catalog", id: "model", reasoning: false, reasoningEfforts: ["high"] }] }), /cannot be set/u);
  assert.throws(() => parseHarnessConfig({ models: [{ provider: "catalog", id: "model", reasoningEfforts: ["turbo"] }] }), /invalid/u);
  assert.throws(() => parseHarnessConfig({ models: [{ provider: "catalog", id: "model", pricing: {} }] }), /at least one price/u);
  assert.throws(() => parseHarnessConfig({ models: [{ provider: "catalog", id: "model", pricing: { input: -1 } }] }), /finite non-negative/u);
  assert.throws(() => parseHarnessConfig({ models: [{ provider: "catalog", id: "model", pricing: { output: Number.POSITIVE_INFINITY } }] }), /finite non-negative/u);
  assert.throws(() => parseHarnessConfig({ models: [{
    provider: "catalog",
    id: "model",
    pricing: { tiers: [
      { name: "first", maximumInputTokens: 100, input: 1 },
      { name: "second", minimumInputTokens: 100, output: 2 },
    ] },
  }] }), /overlapping ranges/u);
  assert.throws(() => parseHarnessConfig({ models: [{ provider: "catalog", id: "model", contextTokens: 2_147_483_648 }] }), /must not exceed/u);
});

test("UI theme selection is typed and preserved in config", () => {
  assert.equal(parseHarnessConfig({ theme: "ocean" }).theme, "ocean");
  assert.equal(parseHarnessConfig({ thinking: "high", scopedModels: ["anthropic/*sonnet*"] }).thinking, "high");
  assert.deepEqual(parseHarnessConfig({ thinking: "high", scopedModels: ["anthropic/*sonnet*"] }).scopedModels, ["anthropic/*sonnet*"]);
  assert.throws(() => parseHarnessConfig({ theme: "" }), /theme must be a non-empty string/u);
  assert.throws(() => parseHarnessConfig({ thinking: "extreme" }), /thinking must be/u);
});

test("double-Escape action is bounded and defaults to the session tree", () => {
  assert.equal(parseHarnessConfig({}).doubleEscapeAction, "tree");
  assert.equal(parseHarnessConfig({ doubleEscapeAction: "fork" }).doubleEscapeAction, "fork");
  assert.equal(parseHarnessConfig({ doubleEscapeAction: "none" }).doubleEscapeAction, "none");
  assert.throws(() => parseHarnessConfig({ doubleEscapeAction: "quit" }), /tree, fork, or none/u);
});

test("command shell path is explicit and absolute", () => {
  assert.equal(parseHarnessConfig({ shellPath: process.execPath }).shellPath, process.execPath);
  assert.throws(() => parseHarnessConfig({ shellPath: "relative/bash" }), /shellPath must be an absolute path/u);
});

test("external execution backends require a bounded explicit authority", () => {
  const configured = parseHarnessConfig({
    executionBackend: {
      id: "remote-tools",
      argv: [process.execPath, "/opt/rigyn/tool-worker.js"],
      cwd: "/tmp",
      workspace: "/workspace",
      tools: { read: "read", write: "write", bash: "write" },
      timeoutMs: 30_000,
      outputLimitBytes: 65_536,
    },
  });
  assert.deepEqual(configured.executionBackend, {
    id: "remote-tools",
    argv: [process.execPath, "/opt/rigyn/tool-worker.js"],
    cwd: "/tmp",
    workspace: "/workspace",
    tools: { read: "read", write: "write", bash: "write" },
    timeoutMs: 30_000,
    outputLimitBytes: 65_536,
  });
  assert.throws(() => parseHarnessConfig({
    executionBackend: { id: "remote", argv: ["node"], cwd: "/tmp", workspace: "/workspace", tools: { read: "read" } },
  }), /absolute executable path/u);
  assert.throws(() => parseHarnessConfig({
    executionBackend: { id: "remote", argv: [process.execPath], cwd: "/tmp", workspace: "/workspace", tools: {} },
  }), /between 1 and 128/u);
  assert.throws(() => parseHarnessConfig({
    executionBackend: { id: "remote", argv: [process.execPath], cwd: "/tmp", workspace: "/workspace", tools: { bash: "maybe" } },
  }), /must be read or write/u);
});

test("package-manager commands are bounded argv arrays and never shell strings", () => {
  const configured = parseHarnessConfig({
    npmCommand: ["mise", "exec", "node@24", "--", "npm"],
    gitCommand: ["/usr/bin/git"],
  });
  assert.deepEqual(configured.npmCommand, ["mise", "exec", "node@24", "--", "npm"]);
  assert.deepEqual(configured.gitCommand, ["/usr/bin/git"]);
  assert.throws(() => parseHarnessConfig({ npmCommand: "npm --unsafe" }), /array/u);
  assert.throws(() => parseHarnessConfig({ npmCommand: [] }), /1 through 32/u);
  assert.throws(() => parseHarnessConfig({ gitCommand: ["git", "bad\0argument"] }), /1 through 32/u);
});

test("external credential helpers are bounded argv configurations with an explicit environment allowlist", () => {
  const configured = parseHarnessConfig({
    credentialCommands: {
      company: {
        argv: [process.execPath, "/opt/company/credential-helper.mjs"],
        environment: ["COMPANY_PROFILE", "COMPANY_REGION"],
        timeoutMs: 5_000,
        maxOutputBytes: 8_192,
        cacheTtlMs: 120_000,
      },
    },
  });
  assert.deepEqual(configured.credentialCommands.company, {
    argv: [process.execPath, "/opt/company/credential-helper.mjs"],
    environment: ["COMPANY_PROFILE", "COMPANY_REGION"],
    timeoutMs: 5_000,
    maxOutputBytes: 8_192,
    cacheTtlMs: 120_000,
  });
  assert.deepEqual(parseHarnessConfig({}).credentialCommands, {});
  assert.throws(() => parseHarnessConfig({ credentialCommands: { company: { argv: [] } } }), /1 through 32/u);
  assert.throws(() => parseHarnessConfig({ credentialCommands: { company: { argv: [process.execPath], environment: ["BAD-NAME"] } } }), /environment/u);
  assert.throws(() => parseHarnessConfig({ credentialCommands: { company: { argv: [process.execPath], timeoutMs: 60_001 } } }), /must not exceed 60000/u);
  assert.throws(() => parseHarnessConfig({ credentialCommands: { company: { argv: [process.execPath], cacheTtlMs: 3_600_001 } } }), /must not exceed 3600000/u);
  assert.throws(() => parseHarnessConfig({ credentialCommands: { company: { argv: [process.execPath], shell: true } } }), /unknown keys/u);
});

test("automatic compaction controls are typed, bounded, and have conservative defaults", () => {
  const defaults = parseHarnessConfig({});
  assert.equal(defaults.autoCompaction, true);
  assert.equal(defaults.compactionRetainRecentTurns, 2);
  assert.equal(defaults.compactionToolResultBytes, 4 * 1_024);
  const configured = parseHarnessConfig({
    autoCompaction: false,
    compactionRetainRecentTurns: 0,
    compactionToolResultBytes: 64,
  });
  assert.equal(configured.autoCompaction, false);
  assert.equal(configured.compactionRetainRecentTurns, 0);
  assert.equal(configured.compactionToolResultBytes, 64);
  assert.throws(() => parseHarnessConfig({ autoCompaction: "no" }), /autoCompaction must be a boolean/u);
  assert.throws(() => parseHarnessConfig({ compactionRetainRecentTurns: 1_001 }), /must not exceed 1000/u);
  assert.throws(() => parseHarnessConfig({ compactionToolResultBytes: 63 }), /integer >= 64/u);
});

test("agent step limit overrides remain strictly positive when configured", () => {
  assert.equal(parseHarnessConfig({}).maxSteps, undefined);
  assert.equal(parseHarnessConfig({ maxSteps: 75 }).maxSteps, 75);
  assert.throws(() => parseHarnessConfig({ maxSteps: 0 }), /integer >= 1/u);
});

test("child-run policy has compatible defaults and configurable bounded maxima", () => {
  assert.deepEqual(parseHarnessConfig({}).childRuns, {
    maxConcurrent: 4,
    defaultMaxSteps: 32,
    maxSteps: 64,
    defaultTimeoutMs: 600_000,
    maxTimeoutMs: 600_000,
    defaultOutputLimitBytes: 64 * 1_024,
    maxOutputLimitBytes: 1_024 * 1_024,
  });
  assert.deepEqual(parseHarnessConfig({
    childRuns: {
      maxConcurrent: 8,
      defaultMaxSteps: 48,
      maxSteps: 128,
      defaultTimeoutMs: 900_000,
      maxTimeoutMs: 1_800_000,
      defaultOutputLimitBytes: 128 * 1_024,
      maxOutputLimitBytes: 2 * 1_024 * 1_024,
    },
  }).childRuns, {
    maxConcurrent: 8,
    defaultMaxSteps: 48,
    maxSteps: 128,
    defaultTimeoutMs: 900_000,
    maxTimeoutMs: 1_800_000,
    defaultOutputLimitBytes: 128 * 1_024,
    maxOutputLimitBytes: 2 * 1_024 * 1_024,
  });
  assert.throws(() => parseHarnessConfig({ childRuns: { maxConcurrent: 17 } }), /maxConcurrent.*1 through 16/u);
  assert.throws(() => parseHarnessConfig({ childRuns: { maxSteps: 257 } }), /maxSteps.*1 through 256/u);
  assert.throws(() => parseHarnessConfig({ childRuns: { maxTimeoutMs: 3_600_001 } }), /maxTimeoutMs.*1 through 3600000/u);
  assert.throws(() => parseHarnessConfig({ childRuns: { maxOutputLimitBytes: 8 * 1_024 * 1_024 + 1 } }), /maxOutputLimitBytes.*1 through 8388608/u);
  assert.throws(() => parseHarnessConfig({ childRuns: { defaultMaxSteps: 65 } }), /defaultMaxSteps.*must not exceed.*maxSteps/u);
  assert.throws(() => parseHarnessConfig({ childRuns: { defaultTimeoutMs: 600_001 } }), /defaultTimeoutMs.*must not exceed.*maxTimeoutMs/u);
  assert.throws(() => parseHarnessConfig({ childRuns: { defaultOutputLimitBytes: 1_024 * 1_024 + 1 } }), /defaultOutputLimitBytes.*must not exceed.*maxOutputLimitBytes/u);
  assert.throws(() => parseHarnessConfig({ childRuns: { recursive: true } }), /childRuns contains unknown keys: recursive/u);
});

test("queue drain modes default to one-at-a-time and accept all", () => {
  const defaults = parseHarnessConfig({});
  assert.equal(defaults.steeringMode, "one-at-a-time");
  assert.equal(defaults.followUpMode, "one-at-a-time");
  const configured = parseHarnessConfig({ steeringMode: "all", followUpMode: "all" });
  assert.equal(configured.steeringMode, "all");
  assert.equal(configured.followUpMode, "all");
  assert.throws(() => parseHarnessConfig({ steeringMode: "batch" }), /steeringMode must be/u);
  assert.throws(() => parseHarnessConfig({ followUpMode: "batch" }), /followUpMode must be/u);
});

test("outbound image policy defaults to allow and accepts only allow or block", () => {
  assert.equal(parseHarnessConfig({}).outboundImages, "allow");
  assert.equal(parseHarnessConfig({ outboundImages: "block" }).outboundImages, "block");
  assert.throws(() => parseHarnessConfig({ outboundImages: "redact" }), /outboundImages must be allow or block/u);
});

test("Gemini protocol selection is explicit and validated", () => {
  const current = parseHarnessConfig({ providers: { gemini: { protocol: "interactions", store: false } } });
  assert.deepEqual(current.providers.gemini, { kind: "gemini", protocol: "interactions", store: false });
  assert.throws(
    () => parseHarnessConfig({ providers: { gemini: { protocol: "future-wire-format" } } }),
    /must be interactions or generate-content/u,
  );
});

test("Anthropic prompt caching is configurable and strict", () => {
  const config = parseHarnessConfig({
    providers: {
      anthropic: {
        promptCache: "1h",
        deferredToolLoading: true,
        eagerToolInputStreaming: false,
        thinking: {
          budgets: { low: 2048, high: 16_384 },
          models: {
            "partner-model": {
              mode: "enabled",
              off: "omit",
              interleaved: "beta",
              allowEmptySignature: true,
            },
          },
        },
      },
    },
  });
  assert.deepEqual(config.providers.anthropic, {
    kind: "anthropic",
    promptCache: "1h",
    deferredToolLoading: true,
    eagerToolInputStreaming: false,
    thinking: {
      budgets: { low: 2048, high: 16_384 },
      models: {
        "partner-model": {
          mode: "enabled",
          off: "omit",
          interleaved: "beta",
          allowEmptySignature: true,
        },
      },
    },
  });
  assert.throws(
    () => parseHarnessConfig({ providers: { anthropic: { promptCache: "forever" } } }),
    /promptCache must be off, 5m, or 1h/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { anthropic: { deferredToolLoading: "yes" } } }),
    /deferredToolLoading must be a boolean/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { anthropic: { eagerToolInputStreaming: "yes" } } }),
    /eagerToolInputStreaming must be a boolean/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { anthropic: { thinking: { budgets: { low: 1023 } } } } }),
    /thinking\.budgets\.low must be an integer >= 1024/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { anthropic: { thinking: { models: { custom: { mode: "guessed" } } } } } }),
    /mode must be adaptive or enabled/u,
  );
});

test("OpenRouter explicit prompt caching is opt-in and strict", () => {
  const config = parseHarnessConfig({ providers: { openrouter: { promptCache: "5m" } } });
  assert.deepEqual(config.providers.openrouter, { kind: "openrouter", promptCache: "5m" });
  assert.throws(
    () => parseHarnessConfig({ providers: { openrouter: { promptCache: "daily" } } }),
    /promptCache must be off, 5m, or 1h/u,
  );
});

test("OpenAI and Bedrock prompt cache controls are explicit and strict", () => {
  assert.deepEqual(parseHarnessConfig({
    providers: {
      openai: {
        promptCacheOptions: { ttl: "30m" },
        promptCacheRetention: "24h",
        serviceTier: "flex",
        deferredToolLoading: true,
      },
    },
  }).providers.openai, {
    kind: "openai",
    promptCacheOptions: { ttl: "30m" },
    promptCacheRetention: "24h",
    serviceTier: "flex",
    deferredToolLoading: true,
  });
  assert.deepEqual(parseHarnessConfig({ providers: { bedrock: { region: "us-east-1", promptCache: "1h" } } }).providers.bedrock, {
    kind: "bedrock",
    region: "us-east-1",
    promptCache: "1h",
  });
  assert.throws(
    () => parseHarnessConfig({ providers: { openai: { promptCacheRetention: "forever" } } }),
    /promptCacheRetention must be/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { openai: { promptCacheOptions: { ttl: "24h" } } } }),
    /promptCacheOptions\.ttl must be 30m/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { openai: { promptCacheOptions: {} } } }),
    /promptCacheOptions\.ttl is required/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { openai: { promptCacheOptions: { ttl: "30m", mode: "explicit" } } } }),
    /promptCacheOptions contains unknown keys: mode/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { openai: { serviceTier: "fastest" } } }),
    /serviceTier must be/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { openai: { deferredToolLoading: "yes" } } }),
    /deferredToolLoading must be a boolean/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { bedrock: { region: "us-east-1", promptCache: "forever" } } }),
    /promptCache must be/u,
  );
});

test("OpenAI Codex WebSocket transport and timeouts are explicit and bounded", () => {
  assert.deepEqual(parseHarnessConfig({
    providers: {
      "openai-codex": {
        transport: "websocket-cached",
        webSocketConnectTimeoutMs: 15_000,
        webSocketIdleTimeoutMs: 300_000,
      },
    },
  }).providers["openai-codex"], {
    kind: "openai-codex",
    transport: "websocket-cached",
    webSocketConnectTimeoutMs: 15_000,
    webSocketIdleTimeoutMs: 300_000,
  });
  assert.throws(
    () => parseHarnessConfig({ providers: { "openai-codex": { transport: "udp" } } }),
    /must be sse, websocket, websocket-cached, or auto/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { "openai-codex": { webSocketConnectTimeoutMs: 600_001 } } }),
    /must not exceed 600000/u,
  );
});

test("Mistral session caching and reasoning protocol are explicit and strict", () => {
  assert.deepEqual(parseHarnessConfig({
    providers: { mistral: { promptCache: "session", reasoningMode: "prompt" } },
  }).providers.mistral, {
    kind: "mistral",
    promptCache: "session",
    reasoningMode: "prompt",
  });
  assert.throws(
    () => parseHarnessConfig({ providers: { mistral: { promptCache: "daily" } } }),
    /promptCache must be off or session/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { mistral: { reasoningMode: "guess" } } }),
    /reasoningMode must be effort or prompt/u,
  );
  assert.deepEqual(parseHarnessConfig({
    providers: { mistral: { protocol: "conversations", store: false, promptCache: "off", reasoningMode: "effort" } },
  }).providers.mistral, {
    kind: "mistral",
    protocol: "conversations",
    store: false,
    promptCache: "off",
    reasoningMode: "effort",
  });
  assert.throws(
    () => parseHarnessConfig({ providers: { mistral: { protocol: "future-wire-format" } } }),
    /protocol must be chat-completions or conversations/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { mistral: { protocol: "conversations", promptCache: "session" } } }),
    /promptCache must be off with protocol conversations/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { mistral: { protocol: "conversations", reasoningMode: "prompt" } } }),
    /reasoningMode must be effort with protocol conversations/u,
  );
  assert.throws(
    () => parseHarnessConfig({ providers: { mistral: { store: true } } }),
    /store is available only with protocol conversations/u,
  );
});

test("HTTP transport proxy and timeout settings are typed and bounded", () => {
  assert.deepEqual(parseHarnessConfig({
    httpTransport: {
      proxy: {
        http: "http://proxy.example:8080",
        https: false,
        noProxy: "localhost,.example.test",
      },
      connectTimeoutMs: 5_000,
      headersTimeoutMs: 30_000,
      bodyTimeoutMs: 120_000,
    },
  }).httpTransport, {
    proxy: {
      http: "http://proxy.example:8080",
      https: false,
      noProxy: "localhost,.example.test",
    },
    connectTimeoutMs: 5_000,
    headersTimeoutMs: 30_000,
    bodyTimeoutMs: 120_000,
  });
  assert.throws(
    () => parseHarnessConfig({ httpTransport: { proxy: { typo: "http://proxy.example" } } }),
    /unknown keys: typo/u,
  );
  assert.throws(
    () => parseHarnessConfig({ httpTransport: { bodyTimeoutMs: 600_001 } }),
    /must not exceed 600000/u,
  );
});

test("provider retry policy is configurable and remains replay-safe by default", () => {
  assert.deepEqual(parseHarnessConfig({}).providerRetry, {
    enabled: true,
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    jitter: 0.2,
  });
  assert.deepEqual(parseHarnessConfig({
    providerRetry: { enabled: false, maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000, jitter: 0 },
  }).providerRetry, {
    enabled: false,
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitter: 0,
  });
  assert.throws(() => parseHarnessConfig({ providerRetry: { maxAttempts: 11 } }), /must not exceed 10/u);
  assert.throws(() => parseHarnessConfig({ providerRetry: { baseDelayMs: 10, maxDelayMs: 1 } }), /must not exceed maxDelayMs/u);
  assert.throws(() => parseHarnessConfig({ providerRetry: { jitter: 1.1 } }), /from 0 through 1/u);
  assert.throws(() => parseHarnessConfig({ providerRetry: { enabled: "sometimes" } }), /must be a boolean/u);
});

test("public OAuth registrations are typed, bounded, and never accept client secrets", () => {
  const config = parseHarnessConfig({
    oauthRegistrations: {
      company: {
        provider: "corp",
        flow: "pkce",
        label: "Company account",
        clientId: "public-client",
        authorizationEndpoint: "https://identity.example.test/authorize",
        tokenEndpoint: "https://identity.example.test/token",
        scopes: ["models.read"],
        callbackPath: "/oauth/company",
        authorizationParameters: { audience: "models" },
      },
      device: {
        provider: "corp",
        flow: "device",
        clientId: "public-device-client",
        deviceEndpoint: "https://identity.example.test/device",
        tokenEndpoint: "https://identity.example.test/token",
        scopes: [],
      },
    },
  });
  assert.equal(config.oauthRegistrations.company?.flow, "pkce");
  assert.equal(config.oauthRegistrations.device?.flow, "device");
  assert.throws(() => parseHarnessConfig({
    oauthRegistrations: {
      unsafe: {
        provider: "corp",
        flow: "pkce",
        clientId: "client",
        clientSecret: "must-not-be-configurable",
        authorizationEndpoint: "https://identity.example.test/authorize",
        tokenEndpoint: "https://identity.example.test/token",
      },
    },
  }), /unknown keys: clientSecret/u);
  assert.throws(() => parseHarnessConfig({
    oauthRegistrations: {
      unsafe: {
        provider: "corp",
        flow: "pkce",
        clientId: "client",
        authorizationEndpoint: "https://identity.example.test/authorize",
        tokenEndpoint: "https://identity.example.test/token",
        authorizationParameters: { client_secret: "must-not-be-configurable" },
      },
    },
  }), /authorizationParameters are invalid/u);
  assert.throws(() => parseHarnessConfig({
    oauthRegistrations: {
      unsafe: {
        provider: "corp",
        flow: "device",
        clientId: "client",
        deviceEndpoint: "http://identity.example.test/device",
        tokenEndpoint: "https://identity.example.test/token",
      },
    },
  }), /HTTPS or loopback HTTP/u);
  assert.throws(() => parseHarnessConfig({
    oauthRegistrations: {
      unsafe: {
        provider: "corp",
        flow: "device",
        clientId: "client",
        deviceEndpoint: "https://identity.example.test/device",
        tokenEndpoint: "https://identity.example.test/token",
        scopes: ["two scopes"],
      },
    },
  }), /scopes are invalid/u);
});

test("trust store canonicalizes workspaces and persists explicit decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-trust-"));
  const store = new TrustStore(join(root, "config", "trust.json"));
  assert.equal(await store.isTrusted(root), false);
  await store.trust(root);
  assert.equal(await store.isTrusted(root), true);
  assert.equal((await store.list()).length, 1);
  await store.deny(root);
  assert.equal(await store.decision(root), false);
  assert.equal(await store.isTrusted(root), false);
  await store.untrust(root);
  assert.equal(await store.isTrusted(root), false);
  assert.equal(await store.decision(root), undefined);
});

test("operator preferences have stable defaults and reject invalid values", () => {
  const defaults = parseHarnessConfig({});
  assert.deepEqual({
    quietStartup: defaults.quietStartup,
    hideThinkingBlock: defaults.hideThinkingBlock,
    treeFilterMode: defaults.treeFilterMode,
    editorPaddingX: defaults.editorPaddingX,
    outputPad: defaults.outputPad,
    showHardwareCursor: defaults.showHardwareCursor,
    terminal: defaults.terminal,
    markdown: defaults.markdown,
    branchSummary: defaults.branchSummary,
  }, {
    quietStartup: false,
    hideThinkingBlock: false,
    treeFilterMode: "default",
    editorPaddingX: 0,
    outputPad: 0,
    showHardwareCursor: true,
    terminal: { showImages: true, imageWidthCells: 80, clearOnShrink: false },
    markdown: { codeBlockIndent: "" },
    branchSummary: { reserveTokens: 16_384, skipPrompt: false },
  });
  const configured = parseHarnessConfig({
    quietStartup: true,
    hideThinkingBlock: true,
    externalEditor: "code --wait",
    treeFilterMode: "labeled-only",
    editorPaddingX: 2,
    outputPad: 1,
    autocompleteMaxVisible: 7,
    showHardwareCursor: false,
    terminal: { showImages: false, imageWidthCells: 60, clearOnShrink: true },
    markdown: { codeBlockIndent: "  " },
    branchSummary: { skipPrompt: true },
    shellCommandPrefix: "source ~/.profile",
  });
  assert.equal(configured.autocompleteMaxVisible, 7);
  assert.equal(configured.shellCommandPrefix, "source ~/.profile");
  assert.throws(() => parseHarnessConfig({ externalEditor: "code 'unfinished" }), /externalEditor contains an unfinished quote/u);
  assert.throws(() => parseHarnessConfig({ outputPad: 2 }), /outputPad must be 0 or 1/u);
  assert.throws(() => parseHarnessConfig({ terminal: { imageWidthCells: 0 } }), /integer >= 1/u);
  assert.throws(() => parseHarnessConfig({ markdown: { codeBlockIndent: "\t" } }), /zero through eight spaces/u);
});

test("operator runtime controls are complete, bounded, and independently configurable", () => {
  const defaults = parseHarnessConfig({});
  assert.deepEqual(defaults.compaction, { reserveTokens: 16_384, keepRecentTokens: 20_000 });
  assert.deepEqual(defaults.images, { autoResize: true });
  assert.equal(defaults.enableSkillCommands, true);
  assert.equal(defaults.showCacheMissNotices, false);
  assert.deepEqual(defaults.warnings, { anthropicExtraUsage: true });
  assert.equal(defaults.thinkingBudgets, undefined);
  assert.deepEqual(defaults.promptRoots, []);
  assert.deepEqual(defaults.themeRoots, []);

  const configured = parseHarnessConfig({
    compaction: { reserveTokens: 8_192, keepRecentTokens: 12_000 },
    branchSummary: { reserveTokens: 4_096, skipPrompt: true },
    images: { autoResize: false },
    enableSkillCommands: false,
    showCacheMissNotices: true,
    warnings: { anthropicExtraUsage: false },
    thinkingBudgets: { minimal: 512, low: 1_024, medium: 4_096, high: 16_384 },
    promptRoots: ["~/prompts", "./shared/*.md"],
    themeRoots: ["~/themes", "./shared/*.json"],
  });
  assert.deepEqual(configured.compaction, { reserveTokens: 8_192, keepRecentTokens: 12_000 });
  assert.deepEqual(configured.branchSummary, { reserveTokens: 4_096, skipPrompt: true });
  assert.deepEqual(configured.images, { autoResize: false });
  assert.equal(configured.enableSkillCommands, false);
  assert.equal(configured.showCacheMissNotices, true);
  assert.deepEqual(configured.warnings, { anthropicExtraUsage: false });
  assert.deepEqual(configured.thinkingBudgets, { minimal: 512, low: 1_024, medium: 4_096, high: 16_384 });
  assert.deepEqual(configured.promptRoots, ["~/prompts", "./shared/*.md"]);
  assert.deepEqual(configured.themeRoots, ["~/themes", "./shared/*.json"]);

  assert.throws(() => parseHarnessConfig({ compaction: { reserveTokens: 0 } }), /integer >= 1/u);
  assert.throws(() => parseHarnessConfig({ branchSummary: { reserveTokens: 0 } }), /integer >= 1/u);
  assert.throws(() => parseHarnessConfig({ images: { autoResize: "yes" } }), /must be a boolean/u);
  assert.throws(() => parseHarnessConfig({ thinkingBudgets: { high: 1_000_001 } }), /must not exceed 1000000/u);
  assert.throws(() => parseHarnessConfig({ promptRoots: Array.from({ length: 33 }, (_, index) => `p${index}`) }), /at most 32/u);
  assert.throws(() => parseHarnessConfig({ themeRoots: ["bad\0root"] }), /at most 32/u);
});
