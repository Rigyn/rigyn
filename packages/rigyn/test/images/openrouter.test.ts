import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenRouterImagesGenerator,
  type ImagesContext,
  type ImagesModel,
} from "../../src/images/index.js";

type OpenAISdk = typeof import("openai");

interface CompletionResult {
  data: Record<string, unknown>;
  response: Response;
  request_id?: string;
}

interface FakeState {
  client?: Record<string, unknown>;
  payloads: unknown[];
  requestOptions: Array<Record<string, unknown>>;
  run(payload: unknown, options: Record<string, unknown>, client: Record<string, unknown>): Promise<CompletionResult>;
}

function fakeSdk(state: FakeState): OpenAISdk {
  class FakeOpenAI {
    readonly chat: {
      completions: {
        create: (
          payload: unknown,
          options: Record<string, unknown>,
        ) => { withResponse(): Promise<CompletionResult> };
      };
    };

    constructor(configuration: Record<string, unknown>) {
      state.client = configuration;
      this.chat = {
        completions: {
          create: (payload, options) => {
            state.payloads.push(payload);
            state.requestOptions.push(options);
            return { withResponse: async () => await state.run(payload, options, configuration) };
          },
        },
      };
    }
  }
  return { default: FakeOpenAI } as unknown as OpenAISdk;
}

function model(overrides: Partial<ImagesModel<"openrouter-images">> = {}): ImagesModel<"openrouter-images"> {
  return {
    id: "google/gemini-test-image",
    name: "Image Model",
    api: "openrouter-images",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    input: ["text", "image"],
    output: ["text", "image"],
    pricing: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 4 },
    headers: { "HTTP-Referer": "https://rigyn.example" },
    ...overrides,
  };
}

const context: ImagesContext = {
  input: [
    { type: "text", text: "draw a dog\ud800" },
    { type: "image", mimeType: "image/png", data: "ZmFrZS1wbmc=" },
  ],
};

function successfulResponse(overrides: Record<string, unknown> = {}): CompletionResult {
  return {
    data: {
      id: "image-response",
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
      },
      choices: [{
        message: {
          content: "Generated image",
          images: [{ image_url: "data:image/png;base64,ZmFrZS1pbWFnZQ==" }],
        },
      }],
      ...overrides,
    },
    response: new Response(null, {
      status: 200,
      headers: { "x-request-id": "req-image", "x-test": "yes" },
    }),
    request_id: "req-image",
  };
}

test("OpenRouter images lazily loads the SDK and preserves payload, hooks, output, and structured usage", async () => {
  let loads = 0;
  const observedResponses: Array<{ status: number; headers: Record<string, string> }> = [];
  const state: FakeState = {
    payloads: [],
    requestOptions: [],
    run: async () => successfulResponse(),
  };
  const generate = createOpenRouterImagesGenerator({
    loadSdk: async () => {
      loads += 1;
      return fakeSdk(state);
    },
  });

  assert.equal(loads, 0);
  const output = await generate(model(), context, {
    apiKey: "secret",
    timeoutMs: 1_234,
    headers: { "HTTP-Referer": null, "x-client": "rigyn", authorization: "blocked" },
    onPayload: (payload) => ({ ...(payload as Record<string, unknown>), caller: "hook" }),
    onResponse: (response) => { observedResponses.push(response); },
  });
  assert.equal(loads, 1);
  assert.equal(output.stopReason, "stop");
  assert.equal(output.responseId, "image-response");
  assert.deepEqual(output.output, [
    { type: "text", text: "Generated image" },
    { type: "image", mimeType: "image/png", data: "ZmFrZS1pbWFnZQ==" },
  ]);
  assert.deepEqual(output.usage, {
    inputTokens: 7,
    outputTokens: 4,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    totalTokens: 16,
    cost: {
      input: 0.000007,
      output: 0.000008,
      cacheRead: 0.0000015,
      cacheWrite: 0.000008,
      total: 0.0000245,
    },
  });
  const payload = state.payloads[0] as Record<string, unknown>;
  assert.equal(payload.caller, "hook");
  assert.deepEqual(payload.modalities, ["image", "text"]);
  const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(messages[0]!.content[0]!.text, "draw a dog");
  assert.equal(
    (messages[0]!.content[1]!.image_url as { url: string }).url,
    "data:image/png;base64,ZmFrZS1wbmc=",
  );
  assert.deepEqual(state.requestOptions[0], {
    timeout: 1_234,
    maxRetries: 0,
    headers: { "x-client": "rigyn" },
  });
  assert.equal(state.client?.apiKey, "secret");
  assert.equal(state.client?.maxRetries, 0);
  assert.deepEqual(observedResponses, [{
    status: 200,
    headers: { "x-request-id": "req-image", "x-test": "yes" },
  }]);

  await generate(model(), { input: [{ type: "text", text: "again" }] }, { apiKey: "secret" });
  assert.equal(loads, 1, "one generator instance should share one lazy SDK import");
});

test("OpenRouter image generation returns aborts and validation failures without loading or rejecting", async () => {
  let loads = 0;
  const controller = new AbortController();
  controller.abort();
  const generate = createOpenRouterImagesGenerator({
    loadSdk: async () => {
      loads += 1;
      throw new Error("must not load");
    },
  });
  const aborted = await generate(model(), context, { apiKey: "secret", signal: controller.signal });
  assert.equal(aborted.stopReason, "aborted");
  assert.equal(aborted.errorMessage, "Request cancelled");
  assert.equal(loads, 0);

  const missing = await generate(model(), context);
  assert.equal(missing.stopReason, "error");
  assert.match(missing.errorMessage ?? "", /No API key/u);
  assert.equal(loads, 0);

  const invalid = await generate(model(), context, { apiKey: "secret", maxRetries: 11 });
  assert.equal(invalid.stopReason, "error");
  assert.match(invalid.errorMessage ?? "", /maxRetries/u);
  assert.equal(loads, 0);
});

test("OpenRouter image generation forwards and observes an in-flight abort signal", async () => {
  const state: FakeState = {
    payloads: [],
    requestOptions: [],
    run: async (_payload, options) => await new Promise<CompletionResult>((_resolve, reject) => {
      const signal = options.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }),
  };
  const controller = new AbortController();
  const generate = createOpenRouterImagesGenerator({ loadSdk: async () => fakeSdk(state) });
  const pending = generate(model(), context, { apiKey: "secret", signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const output = await pending;
  assert.equal(output.stopReason, "aborted");
  assert.equal(output.errorMessage, "Request cancelled");
  assert.equal(state.requestOptions[0]?.signal, controller.signal);
});

test("OpenRouter image errors preserve HTTP status and structured provider reasons", async () => {
  const observed: number[] = [];
  const state: FakeState = {
    payloads: [],
    requestOptions: [],
    run: async () => {
      const error = new Error("403 status code (no body)") as Error & {
        status: number;
        headers: Headers;
        error: unknown;
      };
      error.status = 403;
      error.headers = new Headers({ "x-request-id": "denied" });
      error.error = { error: { message: "blocked by gateway WAF for secret" } };
      throw error;
    },
  };
  const generate = createOpenRouterImagesGenerator({ loadSdk: async () => fakeSdk(state) });
  const output = await generate(model(), context, {
    apiKey: "secret",
    onResponse: (response) => { observed.push(response.status); },
  });
  assert.equal(output.stopReason, "error");
  assert.match(output.errorMessage ?? "", /403/u);
  assert.match(output.errorMessage ?? "", /blocked by gateway WAF/u);
  assert.doesNotMatch(output.errorMessage ?? "", /\bsecret\b/u);
  assert.match(output.errorMessage ?? "", /\[REDACTED\]/u);
  assert.deepEqual(observed, [403]);
});

test("OpenRouter image retries honor server delays, caps, and zero SDK retries", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const state: FakeState = {
    payloads: [],
    requestOptions: [],
    run: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("busy") as Error & { status: number; headers: Headers };
        error.status = 429;
        error.headers = new Headers({ "retry-after-ms": "10" });
        throw error;
      }
      return successfulResponse();
    },
  };
  const generate = createOpenRouterImagesGenerator({
    loadSdk: async () => fakeSdk(state),
    sleep: async (milliseconds) => { waits.push(milliseconds); },
  });
  const output = await generate(model(), context, { apiKey: "secret", maxRetries: 1 });
  assert.equal(output.stopReason, "stop");
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [10]);
  assert.equal(state.requestOptions.every((options) => options.maxRetries === 0), true);

  let cappedAttempts = 0;
  const cappedState: FakeState = {
    payloads: [],
    requestOptions: [],
    run: async () => {
      cappedAttempts += 1;
      const error = new Error("slow down") as Error & { status: number; headers: Headers };
      error.status = 429;
      error.headers = new Headers({ "retry-after": "2" });
      throw error;
    },
  };
  const capped = createOpenRouterImagesGenerator({
    loadSdk: async () => fakeSdk(cappedState),
    sleep: async () => { throw new Error("must not sleep"); },
  });
  const rejectedDelay = await capped(model(), context, {
    apiKey: "secret",
    maxRetries: 1,
    maxRetryDelayMs: 50,
  });
  assert.equal(rejectedDelay.stopReason, "error");
  assert.match(rejectedDelay.errorMessage ?? "", /exceeding the 50ms cap/u);
  assert.equal(cappedAttempts, 1);
});

test("OpenRouter image parsing ignores malformed images and accepts text-part responses", async () => {
  const state: FakeState = {
    payloads: [],
    requestOptions: [],
    run: async () => successfulResponse({
      choices: [{
        message: {
          content: [{ type: "text", text: "first" }, { type: "text", text: " second" }],
          images: [
            { image_url: "https://example.test/remote.png" },
            { image_url: "data:image/png;base64,not base64" },
            { image_url: { url: "data:image/jpeg;base64,aGk=" } },
          ],
        },
      }],
    }),
  };
  const generate = createOpenRouterImagesGenerator({ loadSdk: async () => fakeSdk(state) });
  const output = await generate(model(), context, { apiKey: "secret" });
  assert.deepEqual(output.output, [
    { type: "text", text: "first second" },
    { type: "image", mimeType: "image/jpeg", data: "aGk=" },
  ]);

  const invalidPricing = await generate(model({
    pricing: { input: -1, output: 2, cacheRead: 0.5, cacheWrite: 4 },
  }), context, { apiKey: "secret" });
  assert.equal(invalidPricing.usage?.cost, undefined, "invalid catalog prices must not under-report a cost");
});

test("OpenRouter image SDK fetch rejects oversized response bodies", async () => {
  const state: FakeState = {
    payloads: [],
    requestOptions: [],
    run: async (_payload, _options, client) => {
      const fetchImplementation = client.fetch as typeof fetch;
      await (await fetchImplementation("https://openrouter.ai/api/v1/chat/completions")).text();
      return successfulResponse();
    },
  };
  const generate = createOpenRouterImagesGenerator({
    loadSdk: async () => fakeSdk(state),
    fetch: async () => new Response("too large", { status: 200 }),
  });
  const output = await generate(model(), context, { apiKey: "secret", maxResponseBytes: 2 });
  assert.equal(output.stopReason, "error");
  assert.match(output.errorMessage ?? "", /exceeded 2 bytes/u);
});
