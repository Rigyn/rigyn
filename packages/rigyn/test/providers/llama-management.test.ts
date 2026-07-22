import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalChoice, TerminalPrompter } from "../../src/interfaces/terminal.js";
import { HuggingFaceGgufClient } from "../../src/providers/huggingface-gguf.js";
import { manageLlamaRouter } from "../../src/providers/llama-management.js";
import { LlamaRouterClient } from "../../src/providers/llama-router.js";
import { fakeFetch } from "./helpers.js";

class ScriptedPrompter implements TerminalPrompter {
  readonly #labels: string[];
  readonly #answers: string[];

  constructor(labels: string[], answers: string[] = []) {
    this.#labels = [...labels];
    this.#answers = [...answers];
  }

  async question(): Promise<string> {
    const value = this.#answers.shift();
    if (value === undefined) throw new Error("No scripted answer remains");
    return value;
  }

  async choose<T>(_prompt: string, choices: TerminalChoice<T>[]): Promise<T> {
    const label = this.#labels.shift();
    if (label === undefined) throw new Error("No scripted selection remains");
    const choice = choices.find((candidate) => candidate.label === label);
    if (choice === undefined) throw new Error(`Scripted choice ${label} was unavailable`);
    return choice.value;
  }
}

test("local model manager unloads an active model without deleting it", async () => {
  let status = "loaded";
  const client = new LlamaRouterClient({
    fetch: fakeFetch(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/models/unload") {
        const body = await request.json() as { model: string };
        assert.equal(body.model, "local-model");
        status = "unloaded";
        return Response.json({ success: true });
      }
      return Response.json({ data: [{ id: "local-model", status: { value: status } }] });
    }),
  });
  const result = await manageLlamaRouter({
    terminal: new ScriptedPrompter(["local-model", "Unload", "Close"]),
    client,
  });
  assert.deepEqual(result, { loaded: [], unloaded: ["local-model"], downloaded: [] });
});

test("local model manager downloads an exact quantization and can leave it unloaded", async () => {
  let status: "missing" | "downloading" | "unloaded" = "missing";
  let polls = 0;
  const client = new LlamaRouterClient({
    fetch: fakeFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/models") {
        const body = await request.json() as { model: string };
        assert.equal(body.model, "owner/model-GGUF:Q4_K_M");
        status = "downloading";
        polls = 0;
        return Response.json({ success: true });
      }
      if (status === "downloading" && ++polls >= 2) status = "unloaded";
      return Response.json({
        data: status === "missing" ? [] : [{
          id: "owner/model-GGUF:Q4_K_M",
          status: { value: status, ...(status === "downloading" ? { progress: { file: { done: 5, total: 10 } } } : {}) },
        }],
      });
    }),
  });
  const catalog = new HuggingFaceGgufClient({
    fetch: fakeFetch(() => Response.json({
      id: "owner/model-GGUF",
      siblings: [{ rfilename: "model-Q4_K_M.gguf", size: 10 }],
    })),
  });
  const statusMessages: string[] = [];
  const result = await manageLlamaRouter({
    terminal: new ScriptedPrompter(["Download model…", "Keep unloaded", "Close"], ["owner/model-GGUF:Q4_K_M"]),
    client,
    catalog,
    onStatus(message) {
      if (message !== undefined) statusMessages.push(message);
    },
  });
  assert.deepEqual(result, { loaded: [], unloaded: [], downloaded: ["owner/model-GGUF:Q4_K_M"] });
  assert.equal(statusMessages.includes("Downloading model"), true);
});

test("local model manager asks before unloading other active models", async () => {
  const statuses = new Map([["old", "loaded"], ["new", "unloaded"]]);
  const client = new LlamaRouterClient({
    fetch: fakeFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST") {
        const body = await request.json() as { model: string };
        if (url.pathname === "/models/unload") statuses.set(body.model, "unloaded");
        if (url.pathname === "/models/load") statuses.set(body.model, "loaded");
        return Response.json({ success: true });
      }
      return Response.json({ data: [...statuses].map(([id, value]) => ({ id, status: { value } })) });
    }),
  });
  const result = await manageLlamaRouter({
    terminal: new ScriptedPrompter(["new", "Unload other models", "Close"]),
    client,
  });
  assert.deepEqual(result, { loaded: ["new"], unloaded: ["old"], downloaded: [] });
});

test("local model manager restores replaced models when the replacement fails", async () => {
  const statuses = new Map([[
    "old",
    { value: "loaded", failed: false },
  ], [
    "broken",
    { value: "unloaded", failed: false },
  ]]);
  const mutations: string[] = [];
  const client = new LlamaRouterClient({
    fetch: fakeFetch(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/models/sse") return new Response("");
      if (request.method === "POST") {
        const body = await request.json() as { model: string };
        mutations.push(`${url.pathname}:${body.model}`);
        if (url.pathname === "/models/unload") statuses.set(body.model, { value: "unloaded", failed: false });
        if (url.pathname === "/models/load" && body.model === "broken") {
          statuses.set(body.model, { value: "unloaded", failed: true });
        } else if (url.pathname === "/models/load") {
          statuses.set(body.model, { value: "loaded", failed: false });
        }
        return Response.json({ success: true });
      }
      return Response.json({
        data: [...statuses].map(([id, status]) => ({ id, status })),
      });
    }),
  });

  await assert.rejects(manageLlamaRouter({
    terminal: new ScriptedPrompter(["broken", "Unload other models"]),
    client,
  }), /failed to load broken/u);
  assert.deepEqual(statuses.get("old"), { value: "loaded", failed: false });
  assert.deepEqual(mutations, [
    "/models/unload:old",
    "/models/load:broken",
    "/models/load:old",
  ]);
});

test("local model manager offers a bounded retry after a connection failure", async () => {
  let attempts = 0;
  const client = new LlamaRouterClient({
    fetch: fakeFetch(() => {
      attempts += 1;
      if (attempts === 1) return Response.json({ error: { message: "offline" } }, { status: 503 });
      return Response.json({ data: [] });
    }),
  });
  const result = await manageLlamaRouter({
    terminal: new ScriptedPrompter(["Retry", "Close"]),
    client,
  });
  assert.equal(attempts, 2);
  assert.deepEqual(result, { loaded: [], unloaded: [], downloaded: [] });
});
