import assert from "node:assert/strict";
import test from "node:test";

import type {
  ModelInfo,
  ModelProtocolFamily,
  ProviderAdapter,
  ProviderRequest,
  ProviderState,
} from "../../src/core/types.js";
import { OpenAICompatibleAdapter } from "../../src/providers/openai-compatible.js";
import { defineRoutedProviderAdapter } from "../../src/providers/routed.js";
import { byteChunks, collect, fakeFetch, request, streamResponse } from "./helpers.js";

const OBSERVED_AT = "2026-07-17T00:00:00.000Z";

function model(id: string, provider: string, protocolFamily?: ModelProtocolFamily): ModelInfo {
  return {
    id,
    provider,
    capabilities: {
      tools: { value: "supported", source: "provider", observedAt: OBSERVED_AT },
      reasoning: { value: "unknown", source: "provider", observedAt: OBSERVED_AT },
      images: { value: "unsupported", source: "provider", observedAt: OBSERVED_AT },
    },
    ...(protocolFamily === undefined
      ? {}
      : {
          compatibility: {
            protocolFamily: { value: protocolFamily, source: "provider", observedAt: OBSERVED_AT },
          },
        }),
  };
}

function adapter(
  id: string,
  models: ModelInfo[],
  stream: ProviderAdapter["stream"],
): ProviderAdapter {
  return {
    id,
    stream,
    async listModels(signal) {
      signal.throwIfAborted();
      return models;
    },
  };
}

test("routed provider uses exact public routes and remaps only provider-owned identities", async () => {
  const state: ProviderState = {
    kind: "anthropic_messages",
    assistantBlocks: [{ private: "opaque-state" }],
  };
  let received: ProviderRequest | undefined;
  let receivedSignal: AbortSignal | undefined;
  const responses = adapter("responses-wire", [
    model("responses-upstream", "responses-wire", "openai-responses"),
  ], async function* () {});
  const messages = adapter("messages-wire", [
    model("messages-upstream", "messages-wire", "anthropic-messages"),
  ], async function* (providerRequest, signal) {
    received = providerRequest;
    receivedSignal = signal;
    yield { type: "response_start", model: providerRequest.model };
    yield { type: "unknown_provider_event", provider: "messages-wire", raw: { event: "new" } };
    yield { type: "response_end", reason: "stop", state };
  });
  const routed = defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [
      {
        model: "company-fast",
        upstreamModel: "responses-upstream",
        protocolFamily: "openai-responses",
        adapter: responses,
      },
      {
        model: "company-deep",
        upstreamModel: "messages-upstream",
        protocolFamily: "anthropic-messages",
        adapter: messages,
      },
    ],
  });
  const signal = new AbortController().signal;
  const input = request("company");
  input.model = "company-deep";
  input.providerState = state;
  input.sessionId = "session-route";
  input.metadata = { cache: "stable" };
  input.messages[0]!.content.push({
    type: "provider_opaque",
    provider: "company",
    mediaType: "application/json",
    value: { hidden: true },
  });

  const events = await collect(routed.stream(input, signal));

  assert.strictEqual(receivedSignal, signal);
  assert.equal(received?.provider, "messages-wire");
  assert.equal(received?.model, "messages-upstream");
  assert.equal(received?.sessionId, "session-route");
  assert.strictEqual(received?.metadata, input.metadata);
  assert.equal(received?.providerState, undefined);
  const opaque = received?.messages[0]?.content.at(-1);
  assert.equal(opaque?.type === "provider_opaque" ? opaque.provider : undefined, "messages-wire");
  assert.equal(events[0]?.type === "response_start" ? events[0].model : undefined, "company-deep");
  assert.equal(events[1]?.type === "unknown_provider_event" ? events[1].provider : undefined, "company");
  const publicState = events[2]?.type === "response_end" ? events[2].state : undefined;
  assert.equal(publicState?.kind, "anthropic_messages");
  assert.deepEqual(publicState?.kind === "anthropic_messages" ? publicState.assistantBlocks : undefined, state.assistantBlocks);
  assert.deepEqual(publicState?.routed === undefined ? undefined : {
    provider: publicState.routed.provider,
    model: publicState.routed.model,
    delegate: publicState.routed.delegate,
    upstreamModel: publicState.routed.upstreamModel,
    protocolFamily: publicState.routed.protocolFamily,
  }, {
    provider: "company",
    model: "company-deep",
    delegate: "messages-wire",
    upstreamModel: "messages-upstream",
    protocolFamily: "anthropic-messages",
  });
  assert.match(publicState?.routed?.scope ?? "", /^[0-9a-f-]{36}$/u);

  assert.deepEqual((await routed.listModels(signal)).map((entry) => [
    entry.provider,
    entry.id,
    entry.compatibility?.protocolFamily?.value,
  ]), [
    ["company", "company-deep", "anthropic-messages"],
    ["company", "company-fast", "openai-responses"],
  ]);
});

test("routed provider scopes same-protocol continuation state to one exact delegate route", async () => {
  const nativeState: ProviderState = {
    kind: "openai_responses",
    previousResponseId: "response-a",
    outputItems: [{ private: "delegate-a" }],
  };
  const receivedByA: Array<ProviderState | undefined> = [];
  const receivedByB: Array<ProviderState | undefined> = [];
  const delegateA = adapter("wire-a", [
    model("upstream-a", "wire-a", "openai-responses"),
  ], async function* (providerRequest) {
    receivedByA.push(providerRequest.providerState);
    yield { type: "response_end", reason: "stop", state: nativeState };
  });
  const delegateB = adapter("wire-b", [
    model("upstream-b", "wire-b", "openai-responses"),
  ], async function* (providerRequest) {
    receivedByB.push(providerRequest.providerState);
    yield { type: "response_end", reason: "stop", state: {
      kind: "openai_responses",
      outputItems: [],
    } };
  });
  const routed = defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [
      {
        model: "public-a",
        upstreamModel: "upstream-a",
        protocolFamily: "openai-responses",
        adapter: delegateA,
      },
      {
        model: "public-b",
        upstreamModel: "upstream-b",
        protocolFamily: "openai-responses",
        adapter: delegateB,
      },
    ],
  });

  const first = request("company");
  first.model = "public-a";
  const firstEvents = await collect(routed.stream(first, new AbortController().signal));
  const terminal = firstEvents.at(-1);
  assert.equal(terminal?.type, "response_end");
  if (terminal?.type !== "response_end") throw new Error("Expected a terminal response");
  const persistedState = structuredClone(terminal.state);

  const continued = request("company");
  continued.model = "public-a";
  continued.providerState = persistedState;
  await collect(routed.stream(continued, new AbortController().signal));

  const crossed = request("company");
  crossed.model = "public-b";
  crossed.providerState = persistedState;
  await collect(routed.stream(crossed, new AbortController().signal));

  assert.equal(receivedByA[0], undefined);
  assert.deepEqual(receivedByA[1], nativeState);
  assert.deepEqual(receivedByB, [undefined]);
});

test("routed provider fails closed for missing and ambiguous routes", async () => {
  const delegate = adapter("wire", [model("upstream", "wire")], async function* () {});
  assert.throws(() => defineRoutedProviderAdapter({
    id: " company",
    delegateOwnership: "borrowed",
    routes: [{ model: "available", protocolFamily: "openai-responses", adapter: delegate }],
  }), /exact non-empty provider ID/u);
  const invalidDelegate = adapter("wire\n", [model("upstream", "wire\n")], async function* () {});
  assert.throws(() => defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [{ model: "available", protocolFamily: "openai-responses", adapter: invalidDelegate }],
  }), /adapter ID must be an exact non-empty provider ID/u);
  for (const invalid of [" available", "available ", "available\n", "available\u0085"]) {
    assert.throws(() => defineRoutedProviderAdapter({
      id: "company",
      delegateOwnership: "borrowed",
      routes: [{ model: invalid, protocolFamily: "openai-responses", adapter: delegate }],
    }), /exact non-empty model ID/u);
  }
  assert.throws(() => defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [{
      model: "available",
      upstreamModel: "upstream\talias",
      protocolFamily: "openai-responses",
      adapter: delegate,
    }],
  }), /upstream model must be an exact non-empty model ID/u);
  assert.throws(() => defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [
      { model: "same", protocolFamily: "openai-responses", adapter: delegate },
      { model: "same", protocolFamily: "anthropic-messages", adapter: delegate },
    ],
  }), /ambiguous routes for model same/u);

  const routed = defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [{ model: "available", upstreamModel: "upstream", protocolFamily: "openai-responses", adapter: delegate }],
  });
  const missing = request("company");
  missing.model = "not-routed";
  await assert.rejects(async () => await collect(routed.stream(missing, new AbortController().signal)), /no explicit route/u);

  const wrongProvider = request("another-company");
  wrongProvider.model = "available";
  await assert.rejects(async () => await collect(routed.stream(wrongProvider, new AbortController().signal)), /cannot serve/u);

  const missingUpstream = defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [{ model: "missing", protocolFamily: "openai-responses", adapter: delegate }],
  });
  await assert.rejects(missingUpstream.listModels(new AbortController().signal), /did not advertise model missing/u);
});

test("routed provider accepts explicit catalog metadata without probing an unavailable discovery endpoint", async () => {
  let discoveryCalls = 0;
  const delegate = adapter("private-wire", [], async function* () {});
  delegate.listModels = async () => {
    discoveryCalls += 1;
    throw new Error("discovery is unavailable");
  };
  const routed = defineRoutedProviderAdapter({
    id: "private-gateway",
    delegateOwnership: "borrowed",
    routes: [{
      model: "public-model",
      upstreamModel: "private-model",
      protocolFamily: "anthropic-messages",
      adapter: delegate,
      modelInfo: model("private-model", "private-wire", "anthropic-messages"),
    }],
  });

  const models = await routed.listModels(new AbortController().signal);

  assert.equal(discoveryCalls, 0);
  assert.deepEqual(models.map((entry) => [entry.provider, entry.id]), [["private-gateway", "public-model"]]);
});

test("routed provider preserves route-specific endpoints and adapter configuration", async () => {
  const requests: Array<{ url: string; authorization: string | null; model: unknown }> = [];
  const wire = (label: string) => fakeFetch(async (incoming) => {
    const body = await incoming.json() as { model?: unknown };
    requests.push({
      url: incoming.url,
      authorization: incoming.headers.get("authorization"),
      model: body.model,
    });
    return streamResponse(byteChunks([
      `data: ${JSON.stringify({ id: label, model: body.model, choices: [{ index: 0, delta: { content: label }, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")));
  });
  const east = new OpenAICompatibleAdapter({
    id: "east-wire",
    baseUrl: "https://east.example.test/v1",
    accessToken: "east-token",
    fetch: wire("east"),
  });
  const west = new OpenAICompatibleAdapter({
    id: "west-wire",
    baseUrl: "https://west.example.test/api",
    accessToken: "west-token",
    fetch: wire("west"),
  });
  const routed = defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [
      { model: "east-model", upstreamModel: "east-upstream", protocolFamily: "openai-chat-completions", adapter: east },
      { model: "west-model", upstreamModel: "west-upstream", protocolFamily: "openai-chat-completions", adapter: west },
    ],
  });

  const eastRequest = request("company");
  eastRequest.model = "east-model";
  const westRequest = request("company");
  westRequest.model = "west-model";
  await collect(routed.stream(eastRequest, new AbortController().signal));
  await collect(routed.stream(westRequest, new AbortController().signal));

  assert.deepEqual(requests, [
    {
      url: "https://east.example.test/v1/chat/completions",
      authorization: "Bearer east-token",
      model: "east-upstream",
    },
    {
      url: "https://west.example.test/api/chat/completions",
      authorization: "Bearer west-token",
      model: "west-upstream",
    },
  ]);
});

test("routed provider propagates aborts and errors without retaining cross-route state", async () => {
  const failure = new Error("delegate failed");
  const observedStates: Array<ProviderState | undefined> = [];
  const failing = adapter("failing-wire", [model("failing", "failing-wire")], async function* () {
    throw failure;
  });
  const blocking = adapter("blocking-wire", [model("blocking", "blocking-wire")], async function* (providerRequest, signal) {
    observedStates.push(providerRequest.providerState);
    signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const routed = defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [
      { model: "failing", protocolFamily: "openai-responses", adapter: failing },
      { model: "blocking", protocolFamily: "anthropic-messages", adapter: blocking },
    ],
  });
  const failingRequest = request("company");
  failingRequest.model = "failing";
  await assert.rejects(async () => await collect(routed.stream(failingRequest, new AbortController().signal)), failure);

  const controller = new AbortController();
  const blockingRequest = request("company");
  blockingRequest.model = "blocking";
  blockingRequest.providerState = { kind: "openai_responses", outputItems: [{ private: true }] };
  const pending = collect(routed.stream(blockingRequest, controller.signal));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const abortReason = new Error("route cancelled");
  controller.abort(abortReason);
  await assert.rejects(pending, abortReason);
  assert.deepEqual(observedStates, [undefined]);
});

test("routed provider rejects protocol metadata that conflicts with its explicit route", async () => {
  const delegate = adapter("wire", [
    model("upstream", "wire", "anthropic-messages"),
  ], async function* () {});
  const routed = defineRoutedProviderAdapter({
    id: "company",
    delegateOwnership: "borrowed",
    routes: [{ model: "public", upstreamModel: "upstream", protocolFamily: "openai-responses", adapter: delegate }],
  });

  await assert.rejects(routed.listModels(new AbortController().signal), /advertises anthropic-messages/u);
});

test("routed provider makes delegate lifecycle ownership explicit and idempotent", async () => {
  let ownedDisposals = 0;
  const ownedDelegate: ProviderAdapter = {
    ...adapter("owned-wire", [model("one", "owned-wire"), model("two", "owned-wire")], async function* () {}),
    dispose() { ownedDisposals += 1; },
  };
  const owned = defineRoutedProviderAdapter({
    id: "owned-company",
    delegateOwnership: "owned",
    routes: [
      { model: "one", protocolFamily: "openai-responses", adapter: ownedDelegate },
      { model: "two", protocolFamily: "openai-responses", adapter: ownedDelegate },
    ],
  });
  await Promise.all([owned.dispose!(), owned.dispose!()]);
  assert.equal(ownedDisposals, 1);

  let borrowedDisposals = 0;
  const borrowedDelegate: ProviderAdapter = {
    ...adapter("borrowed-wire", [model("one", "borrowed-wire")], async function* () {}),
    dispose() { borrowedDisposals += 1; },
  };
  const borrowed = defineRoutedProviderAdapter({
    id: "borrowed-company",
    delegateOwnership: "borrowed",
    routes: [{ model: "one", protocolFamily: "openai-responses", adapter: borrowedDelegate }],
  });
  assert.equal(borrowed.dispose, undefined);
  assert.equal(borrowedDisposals, 0);
});
