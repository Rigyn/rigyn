import assert from "node:assert/strict";
import test from "node:test";
import {
  LlamaRouterAdapter,
  LlamaRouterClient,
  normalizeLlamaRouterUrl,
} from "../../src/providers/llama-router.js";
import { byteChunks, collect, fakeFetch, readable, request } from "./helpers.js";

test("llama.cpp router URLs permit only HTTPS or loopback HTTP", () => {
  assert.equal(normalizeLlamaRouterUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080");
  assert.equal(normalizeLlamaRouterUrl("http://[::1]:8080/v1"), "http://[::1]:8080");
  assert.equal(normalizeLlamaRouterUrl("https://router.example/v1"), "https://router.example");
  assert.throws(() => normalizeLlamaRouterUrl("http://router.example"), /HTTPS or loopback HTTP/u);
  assert.throws(() => normalizeLlamaRouterUrl("https://user:secret@router.example"), /must not contain credentials/u);
});

test("llama.cpp router management uses authenticated bounded endpoints", async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
  const client = new LlamaRouterClient({
    baseUrl: "https://router.example/v1",
    apiKey: async () => "local-secret",
    fetch: fakeFetch(async (request) => {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: request.method === "POST" ? await request.json() : undefined,
      });
      if (request.url.endsWith("/models?reload=1")) {
        return Response.json({ data: [{ id: "ready", status: { value: "loaded" } }] });
      }
      return Response.json({ success: true });
    }),
  });

  assert.deepEqual((await client.list({ reload: true })).map((model) => model.id), ["ready"]);
  await client.load("ready");
  await client.unload("ready");
  await client.download("owner/model:Q4_K_M");

  assert.deepEqual(requests.map(({ url, method, body }) => [new URL(url).pathname + new URL(url).search, method, body]), [
    ["/models?reload=1", "GET", undefined],
    ["/models/load", "POST", { model: "ready" }],
    ["/models/unload", "POST", { model: "ready" }],
    ["/models", "POST", { model: "owner/model:Q4_K_M" }],
  ]);
  assert.ok(requests.every((request) => request.authorization === "Bearer local-secret"));
});

test("llama.cpp router waits for load, download, and unload terminal states", async () => {
  const states = new Map<string, string>([
    ["load-me", "unloaded"],
    ["download-me", "unloaded"],
    ["unload-me", "loaded"],
  ]);
  const polls = new Map<string, number>();
  const client = new LlamaRouterClient({
    fetch: fakeFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST") {
        const body = await request.json() as { model: string };
        polls.set(body.model, 0);
        if (url.pathname === "/models/load") states.set(body.model, "loading");
        if (url.pathname === "/models/unload") states.set(body.model, "loading");
        if (url.pathname === "/models") states.set(body.model, "downloading");
        return Response.json({ success: true });
      }
      const data = [...states].map(([id, initial]) => {
        const count = (polls.get(id) ?? 0) + 1;
        polls.set(id, count);
        let value = initial;
        if (id === "load-me" && initial === "loading" && count >= 2) value = "loaded";
        if (id === "download-me" && initial === "downloading" && count >= 2) value = "unloaded";
        if (id === "unload-me" && initial === "loading" && count >= 2) value = "unloaded";
        states.set(id, value);
        return {
          id,
          status: {
            value,
            ...(value === "downloading" ? { progress: { file: { done: 5, total: 10 } } } : {}),
          },
        };
      });
      return Response.json({ data });
    }),
  });

  assert.equal((await client.loadAndWait("load-me")).status.value, "loaded");
  const progress: Array<{ ratio?: number }> = [];
  assert.equal((await client.downloadAndWait("download-me", (entry) => progress.push(entry))).status.value, "unloaded");
  assert.equal(progress.some((entry) => entry.ratio === 0.5), true);
  await client.unloadAndWait("unload-me");
});

test("llama.cpp catalog exposes only runnable models with live evidence", async () => {
  const adapter = new LlamaRouterAdapter({
    fetch: fakeFetch(() => Response.json({
      data: [
        {
          id: "vision-ready",
          aliases: ["vision"],
          status: { value: "loaded" },
          architecture: { input_modalities: ["text", "image"] },
          meta: { n_ctx: 32_768, size: 42, ftype: "Q4_K_M" },
        },
        { id: "sleeping", status: { value: "sleeping" }, meta: { n_ctx_train: 8_192 } },
        { id: "not-loaded", status: { value: "unloaded" } },
      ],
    })),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => model.id), ["vision-ready", "sleeping"]);
  assert.equal(models[0]?.contextTokens, 32_768);
  assert.equal(models[0]?.capabilities.images.value, "supported");
  assert.deepEqual(models[0]?.compatibility?.inputModalities?.value, ["text", "image"]);
  assert.deepEqual(models[0]?.metadata, {
    status: "loaded",
    aliases: ["vision"],
    sizeBytes: 42,
    fileType: "Q4_K_M",
  });
});

test("llama.cpp inference uses conservative chat-completion request fields", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = new LlamaRouterAdapter({
    fetch: fakeFetch(async (incoming) => {
      body = await incoming.json() as Record<string, unknown>;
      return new Response([
        `data: ${JSON.stringify({ id: "chat", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }),
  });
  const input = request("llama.cpp");
  input.model = "local.gguf";
  input.maxOutputTokens = 256;
  input.reasoningEffort = "high";
  assert.equal((await collect(adapter.stream(input, new AbortController().signal))).at(-1)?.type, "response_end");
  assert.equal(body?.max_tokens, 256);
  assert.equal(body?.max_completion_tokens, undefined);
  assert.equal(body?.stream_options, undefined);
  assert.equal(body?.reasoning_effort, undefined);
});

test("llama.cpp catalog rejects single-model servers and invalid status values", async () => {
  const singleModel = new LlamaRouterClient({
    fetch: fakeFetch(() => Response.json({ data: [{ id: "model-without-router-status" }] })),
  });
  await assert.rejects(singleModel.list(), /not in router mode/u);

  const malformed = new LlamaRouterClient({
    fetch: fakeFetch(() => Response.json({ data: [{ id: "bad", status: { value: "ready" } }] })),
  });
  await assert.rejects(malformed.list(), /not in router mode/u);
});

test("llama.cpp event stream ignores malformed frames and preserves valid events", async () => {
  const frames = [
    "data: not-json\n\n",
    `data: ${JSON.stringify({ model: "ready", event: "status_change", data: { status: "loaded" } })}\n\n`,
  ].join("");
  const client = new LlamaRouterClient({
    apiKey: "secret",
    fetch: fakeFetch((request) => {
      assert.equal(request.headers.get("accept"), "text/event-stream");
      assert.equal(request.headers.get("authorization"), "Bearer secret");
      return new Response(readable(byteChunks(frames, [1, 2, 3, 5, 8, 13])), {
        headers: { "content-type": "text/event-stream" },
      });
    }),
  });
  const events: unknown[] = [];
  await client.watch((event) => events.push(event));
  assert.deepEqual(events, [{ model: "ready", event: "status_change", data: { status: "loaded" } }]);
});

test("llama.cpp load and download waits consume progress events while catalog polling remains authoritative", async () => {
  const states = new Map<string, string>([["load-progress", "unloaded"], ["download-progress", "unloaded"]]);
  let downloadPolls = 0;
  const progressFrames = [
    `data: ${JSON.stringify({
      model: "load-progress",
      event: "model_status",
      data: { status: "loading", progress: { stages: ["allocate", "ready"], current: "allocate", value: 0.5 } },
    })}\n\n`,
    `data: ${JSON.stringify({
      model: "download-progress",
      event: "download_progress",
      data: { file: { done: 3, total: 4 } },
    })}\n\n`,
  ].join("");
  const client = new LlamaRouterClient({
    fetch: fakeFetch(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/models/sse") {
        return new Response(readable(byteChunks(progressFrames, [3, 5, 8])));
      }
      if (request.method === "POST") {
        const body = await request.json() as { model: string };
        if (url.pathname === "/models/load") states.set(body.model, "loaded");
        if (url.pathname === "/models") states.set(body.model, "downloading");
        return Response.json({ success: true });
      }
      if (states.get("download-progress") === "downloading" && ++downloadPolls >= 2) {
        states.set("download-progress", "unloaded");
      }
      return Response.json({
        data: [...states].map(([id, value]) => ({
          id,
          status: { value, ...(value === "downloading" ? { progress: { file: { done: 3, total: 4 } } } : {}) },
        })),
      });
    }),
  });
  const loadProgress: Array<{ ratio?: number }> = [];
  const downloadProgress: Array<{ ratio?: number }> = [];
  await client.loadAndWait("load-progress", (value) => loadProgress.push(value));
  await client.downloadAndWait("download-progress", (value) => downloadProgress.push(value));

  assert.equal(loadProgress.some((value) => value.ratio === 0.25), true);
  assert.equal(downloadProgress.some((value) => value.ratio === 0.75), true);
});

test("llama.cpp router rejects oversized catalogs before parsing", async () => {
  const client = new LlamaRouterClient({
    fetch: fakeFetch(() => new Response("x".repeat(4 * 1_024 * 1_024 + 1))),
  });
  await assert.rejects(client.list(), /exceeded 4 MiB/u);
});
