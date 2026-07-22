import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverHuggingFaceToken,
  HuggingFaceGgufClient,
} from "../../src/providers/huggingface-gguf.js";
import { fakeFetch } from "./helpers.js";

test("GGUF search uses the bounded catalog query and optional authentication", async () => {
  const client = new HuggingFaceGgufClient({
    token: "catalog-secret",
    fetch: fakeFetch((request) => {
      const url = new URL(request.url);
      assert.equal(url.pathname, "/api/models");
      assert.equal(url.searchParams.get("search"), "coder model");
      assert.equal(url.searchParams.get("filter"), "gguf");
      assert.equal(url.searchParams.get("sort"), "downloads");
      assert.equal(url.searchParams.get("direction"), "-1");
      assert.equal(url.searchParams.get("limit"), "20");
      assert.equal(request.headers.get("authorization"), "Bearer catalog-secret");
      return Response.json([
        { id: "owner/model-GGUF", downloads: 42 },
        { id: "owner/no-count" },
        { downloads: 1 },
      ]);
    }),
  });

  assert.deepEqual(await client.search(" coder model "), [
    { id: "owner/model-GGUF", downloads: 42 },
    { id: "owner/no-count", downloads: 0 },
  ]);
});

test("GGUF details aggregate shards, ignore projectors, and prioritize Q4_K_M", async () => {
  const client = new HuggingFaceGgufClient({
    fetch: fakeFetch((request) => {
      assert.equal(new URL(request.url).pathname, "/api/models/owner/model-GGUF");
      return Response.json({
        id: "owner/model-GGUF",
        gated: "manual",
        siblings: [
          { rfilename: "model-Q5_K_M.gguf", size: 6_000 },
          { rfilename: "model-Q4_K_M-00001-of-00002.gguf", size: 2_000 },
          { rfilename: "model-Q4_K_M-00002-of-00002.gguf", size: 3_000 },
          { rfilename: "mmproj-F16.gguf", size: 1_000 },
          { rfilename: "notes.txt", size: 50 },
        ],
      });
    }),
  });

  assert.deepEqual(await client.details("owner/model-GGUF"), {
    id: "owner/model-GGUF",
    gated: "manual",
    quantizations: [
      { name: "Q4_K_M", sizeBytes: 5_000 },
      { name: "Q5_K_M", sizeBytes: 6_000 },
    ],
  });
});

test("GGUF client reports rate-limit delay and rejects unsafe remote HTTP", async () => {
  assert.throws(() => new HuggingFaceGgufClient({ baseUrl: "http://catalog.example" }), /HTTPS or loopback/u);
  const client = new HuggingFaceGgufClient({
    fetch: fakeFetch(() => Response.json({ error: "slow down" }, {
      status: 429,
      headers: { "retry-after": "17" },
    })),
  });
  await assert.rejects(client.search("model"), /retry in 17s/u);
});

test("GGUF token discovery uses environment then documented cache locations", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-hf-token-"));
  const cache = join(root, "cache");
  await mkdir(join(cache, "huggingface"), { recursive: true });
  await writeFile(join(cache, "huggingface", "token"), "file-token\n", "utf8");

  assert.equal(await discoverHuggingFaceToken({ HF_TOKEN: " env-token " }, root), "env-token");
  assert.equal(await discoverHuggingFaceToken({ XDG_CACHE_HOME: cache }, root), "file-token");
  assert.equal(await discoverHuggingFaceToken({}, root), undefined);
});

test("GGUF inputs and result sizes are bounded", async () => {
  const client = new HuggingFaceGgufClient({
    fetch: fakeFetch(() => Response.json(Array.from({ length: 21 }, (_, index) => ({ id: `owner/model-${index}` })))),
  });
  await assert.rejects(client.search("model"), /invalid search results/u);
  await assert.rejects(client.details("not-a-repository"), /owner\/name/u);
});
