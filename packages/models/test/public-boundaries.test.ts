import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { providerResponseDiagnostic } from "../src/index.ts";

const entries = [
  "../src/index.ts",
  "../src/compat.ts",
  "../src/oauth.ts",
  "../src/bedrock-provider.ts",
  "../src/api/openai-responses.ts",
  "../src/api/openai-completions.ts",
  "../src/api/openai-codex-responses.ts",
  "../src/api/azure-openai-responses.ts",
  "../src/api/anthropic-messages.ts",
  "../src/api/google-generative-ai.ts",
  "../src/api/google-vertex.ts",
  "../src/api/bedrock-converse-stream.ts",
  "../src/api/openrouter-images.ts",
  "../src/providers/all.ts",
  "../src/providers/openai.ts",
  "../src/providers/anthropic.ts",
  "../src/providers/google.ts",
  "../src/providers/kimi-code.ts",
  "../src/providers/openrouter.ts",
  "../src/providers/deepseek.ts",
  "../src/providers/openai-codex.ts",
  "../src/providers/github-copilot.ts",
  "../src/providers/xai.ts",
  "../src/providers/ollama.ts",
  "../src/providers/opencode.ts",
  "../src/providers/opencode-go.ts",
  "../src/providers/faux.ts",
] as const;

test("documented public entrypoints import without ambient configuration", async () => {
  for (const entry of entries) {
    const loaded = await import(entry);
    assert.ok(Object.keys(loaded).length > 0, `${entry} exported nothing`);
  }
});

test("every wildcard API and provider entrypoint imports as a public module", async () => {
  const sourceRoot = new URL("../src/", import.meta.url);
  const files = (await readdir(sourceRoot, { recursive: true }))
    .map((file) => file.split(sep).join("/"));
  const entrypoints = files.filter((file) => (
    (file.startsWith("api/") || file.startsWith("providers/"))
    && file.endsWith(".ts")
    && !file.includes("/data/")
  ));
  assert.ok(entrypoints.length > 0);
  for (const file of entrypoints) {
    await import(new URL(file, sourceRoot).href);
  }
});

test("browser-safe root and compatibility entrypoints do not pull Bun or Node-only OAuth helpers", async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    entryPoints: ["src/index.ts", "src/compat.ts", "src/api/openrouter-images.ts", "src/providers/openrouter-images.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    splitting: true,
    outdir: "out",
    logLevel: "silent",
  });
  const output = result.outputFiles.map((file) => file.text).join("\n");
  assert.doesNotMatch(output, /node:/u);
  assert.doesNotMatch(output, /Bun is required by openOAuthUrl/u);
  assert.doesNotMatch(output, /xdg-open|cmd.*start/u);
});

test("fresh provider source contains no literal OAuth client registration", async () => {
  const sourceRoot = new URL("../src/", import.meta.url);
  const files = (await readdir(sourceRoot, { recursive: true }))
    .map((file) => file.split(sep).join("/"));
  const source = (await Promise.all(files
    .filter((file) => file.endsWith(".ts"))
    .map((file) => readFile(new URL(file, sourceRoot), "utf8")))).join("\n");
  assert.doesNotMatch(source, /\bclient(?:Id|_id)\s*:\s*["'][^"']+["']/u);
});

test("package metadata matches the public runtime contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    name?: unknown;
    version?: unknown;
    type?: unknown;
    engines?: { node?: unknown };
    exports?: Record<string, unknown>;
  };
  assert.equal(manifest.name, "@rigyn/models");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.engines?.node, ">=26.7.0");
  for (const path of [".", "./compat", "./providers/*", "./api/*", "./oauth", "./bedrock-provider", "./bun-oauth"]) {
    assert.ok(Object.hasOwn(manifest.exports ?? {}, path), "missing export " + path);
  }
});

test("root exports a bounded provider response diagnostic constructor", () => {
  assert.equal(typeof providerResponseDiagnostic, "function");
  assert.deepEqual(providerResponseDiagnostic({
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": "request_123",
      "set-cookie": "must-not-escape",
    },
  }, 123), {
    type: "provider_response",
    timestamp: 123,
    details: {
      response: {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": "request_123",
        },
      },
      requestId: "request_123",
    },
  });
});
