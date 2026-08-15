import assert from "node:assert/strict";
import test from "node:test";
import type { ImageBlock, ProviderAdapter, ProviderId, ProviderRequest } from "../../src/core/types.js";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { BedrockAdapter } from "../../src/providers/bedrock.js";
import { GeminiInteractionsAdapter } from "../../src/providers/gemini-interactions.js";
import { GeminiAdapter, VertexAdapter } from "../../src/providers/gemini.js";
import {
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_MEDIA_TYPE_LENGTH,
  MAX_IMAGE_URL_LENGTH,
  normalizeImageSource,
} from "../../src/providers/images.js";
import { OllamaAdapter } from "../../src/providers/ollama.js";
import { OpenAICompatibleAdapter, OpenRouterAdapter } from "../../src/providers/openai-compatible.js";
import { AzureOpenAIResponsesAdapter, OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import { collect, fakeFetch, request } from "./helpers.js";

type AdapterFactory = (fetch: typeof globalThis.fetch) => ProviderAdapter;

interface ShapeCase {
  name: string;
  provider: ProviderId;
  adapter: AdapterFactory;
  remoteUrl: string;
  select: (body: Record<string, unknown>) => unknown;
  expected: unknown;
}

const responseImageContent = [
  { type: "input_text", text: "compare" },
  { type: "input_image", image_url: "https://images.example.test/photo.jpg" },
  { type: "input_image", image_url: "data:image/gif;base64,R0lGODlh" },
  { type: "input_image", image_url: "data:image/png;base64,AQID" },
];

const chatImageContent = [
  { type: "text", text: "compare" },
  { type: "image_url", image_url: { url: "https://images.example.test/photo.jpg" } },
  { type: "image_url", image_url: { url: "data:image/gif;base64,R0lGODlh" } },
  { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
];

const shapeCases: ShapeCase[] = [
  {
    name: "OpenAI Responses",
    provider: "openai",
    adapter: (fetch) => new OpenAIResponsesAdapter({ apiKey: "offline", fetch }),
    remoteUrl: "https://images.example.test/photo.jpg",
    select: (body) => ((body.input as Array<{ content: unknown }>)[0]?.content),
    expected: responseImageContent,
  },
  {
    name: "Azure OpenAI Responses",
    provider: "azure-openai",
    adapter: (fetch) => new AzureOpenAIResponsesAdapter({ endpoint: "https://azure.example.test", apiKey: "offline", fetch }),
    remoteUrl: "https://images.example.test/photo.jpg",
    select: (body) => ((body.input as Array<{ content: unknown }>)[0]?.content),
    expected: responseImageContent,
  },
  {
    name: "Anthropic Messages",
    provider: "anthropic",
    adapter: (fetch) => new AnthropicAdapter({ apiKey: "offline", fetch }),
    remoteUrl: "https://images.example.test/photo.jpg",
    select: (body) => ((body.messages as Array<{ content: unknown }>)[0]?.content),
    expected: [
      { type: "text", text: "compare" },
      { type: "image", source: { type: "url", url: "https://images.example.test/photo.jpg" } },
      { type: "image", source: { type: "base64", media_type: "image/gif", data: "R0lGODlh" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
  },
  {
    name: "Gemini GenerateContent",
    provider: "gemini",
    adapter: (fetch) => new GeminiAdapter({ apiKey: "offline", fetch }),
    remoteUrl: "https://generativelanguage.googleapis.com/v1beta/files/file-1",
    select: (body) => ((body.contents as Array<{ parts: unknown }>)[0]?.parts),
    expected: [
      { text: "compare" },
      { fileData: { mimeType: "image/jpeg", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/file-1" } },
      { inlineData: { mimeType: "image/gif", data: "R0lGODlh" } },
      { inlineData: { mimeType: "image/png", data: "AQID" } },
    ],
  },
  {
    name: "Vertex GenerateContent",
    provider: "vertex",
    adapter: (fetch) => new VertexAdapter({ project: "offline-project", accessToken: "offline", fetch }),
    remoteUrl: "gs://offline-bucket/photo.jpg",
    select: (body) => ((body.contents as Array<{ parts: unknown }>)[0]?.parts),
    expected: [
      { text: "compare" },
      { fileData: { mimeType: "image/jpeg", fileUri: "gs://offline-bucket/photo.jpg" } },
      { inlineData: { mimeType: "image/gif", data: "R0lGODlh" } },
      { inlineData: { mimeType: "image/png", data: "AQID" } },
    ],
  },
  {
    name: "Gemini Interactions",
    provider: "gemini",
    adapter: (fetch) => new GeminiInteractionsAdapter({ apiKey: "offline", fetch }),
    remoteUrl: "https://generativelanguage.googleapis.com/v1beta/files/file-1",
    select: (body) => ((body.input as Array<{ content: unknown }>)[0]?.content),
    expected: [
      { type: "text", text: "compare" },
      { type: "image", mime_type: "image/jpeg", uri: "https://generativelanguage.googleapis.com/v1beta/files/file-1" },
      { type: "image", mime_type: "image/gif", data: "R0lGODlh" },
      { type: "image", mime_type: "image/png", data: "AQID" },
    ],
  },
  {
    name: "OpenAI-compatible Chat Completions",
    provider: "openai-compatible",
    adapter: (fetch) => new OpenAICompatibleAdapter({ baseUrl: "https://chat.example.test/v1", apiKey: "offline", fetch }),
    remoteUrl: "https://images.example.test/photo.jpg",
    select: (body) => ((body.messages as Array<{ content: unknown }>)[0]?.content),
    expected: chatImageContent,
  },
  {
    name: "OpenRouter Chat Completions",
    provider: "openrouter",
    adapter: (fetch) => new OpenRouterAdapter({ apiKey: "offline", fetch }),
    remoteUrl: "https://images.example.test/photo.jpg",
    select: (body) => ((body.messages as Array<{ content: unknown }>)[0]?.content),
    expected: chatImageContent,
  },
  {
    name: "Bedrock Converse",
    provider: "bedrock",
    adapter: (fetch) => new BedrockAdapter({ region: "us-east-1", signer: (unsigned) => unsigned, fetch }),
    remoteUrl: "s3://offline-bucket/photo.jpg",
    select: (body) => ((body.messages as Array<{ content: unknown }>)[0]?.content),
    expected: [
      { text: "compare" },
      { image: { format: "jpeg", source: { s3Location: { uri: "s3://offline-bucket/photo.jpg" } } } },
      { image: { format: "gif", source: { bytes: "R0lGODlh" } } },
      { image: { format: "png", source: { bytes: "AQID" } } },
    ],
  },
];

test("native provider adapters serialize URL, data URL, and raw base64 images", async (t) => {
  for (const entry of shapeCases) {
    await t.test(entry.name, async () => {
      let posted: Record<string, unknown> | undefined;
      const adapter = entry.adapter(fakeFetch(async (incoming) => {
        posted = await incoming.json() as Record<string, unknown>;
        return offlineFailure();
      }));
      const providerRequest = imageRequest(entry.provider, [
        { type: "image", mediaType: "image/jpeg", url: entry.remoteUrl },
        { type: "image", mediaType: "IMAGE/GIF", url: "data:image/gif;base64,R0lGODlh" },
        { type: "image", mediaType: "image/png", data: "AQID" },
      ]);

      await collect(adapter.stream(providerRequest, new AbortController().signal));
      assert.ok(posted);
      assert.deepEqual(entry.select(posted), entry.expected);
    });
  }
});

test("Ollama serializes data URLs and raw base64 without the data URL prefix", async () => {
  let posted: { messages?: Array<{ images?: string[] }> } | undefined;
  const adapter = new OllamaAdapter({
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as { messages?: Array<{ images?: string[] }> };
      return offlineFailure();
    }),
  });
  const providerRequest = imageRequest("ollama", [
    { type: "image", mediaType: "image/gif", url: "data:image/gif;base64,R0lGODlh" },
    { type: "image", mediaType: "image/png", data: "AQID" },
  ]);

  await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.deepEqual(posted?.messages?.[0]?.images, ["R0lGODlh", "AQID"]);
});

test("chat-completions and Ollama retain images returned beside a tool result", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=";
  let chatMessages: Array<Record<string, unknown>> | undefined;
  const chat = new OpenAICompatibleAdapter({
    baseUrl: "https://chat.example.test/v1",
    apiKey: "offline",
    fetch: fakeFetch(async (incoming) => {
      const body = await incoming.json() as { messages?: Array<Record<string, unknown>> };
      chatMessages = body.messages;
      return offlineFailure();
    }),
  });
  await collect(chat.stream(toolImageRequest("openai-compatible", png), new AbortController().signal));
  assert.deepEqual(chatMessages?.slice(-2), [
    { role: "tool", tool_call_id: "read-image", content: "attached pixel.png" },
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }],
    },
  ]);

  let ollamaMessages: Array<Record<string, unknown>> | undefined;
  const ollama = new OllamaAdapter({
    fetch: fakeFetch(async (incoming) => {
      const body = await incoming.json() as { messages?: Array<Record<string, unknown>> };
      ollamaMessages = body.messages;
      return offlineFailure();
    }),
  });
  await collect(ollama.stream(toolImageRequest("ollama", png), new AbortController().signal));
  assert.deepEqual(ollamaMessages?.slice(-2), [
    { role: "tool", tool_name: "read", content: "attached pixel.png" },
    { role: "user", content: "", images: [png] },
  ]);
});

test("native structured protocols keep tool-result images correlated with their result", async (t) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=";
  const cases: Array<{
    name: string;
    provider: ProviderId;
    adapter(fetch: typeof globalThis.fetch): ProviderAdapter;
    select(body: Record<string, unknown>): unknown;
    expected: unknown;
  }> = [
    {
      name: "OpenAI Responses",
      provider: "openai",
      adapter: (fetch) => new OpenAIResponsesAdapter({ apiKey: "offline", fetch }),
      select: (body) => (body.input as unknown[]).at(-1),
      expected: {
        type: "function_call_output",
        call_id: "read-image",
        output: [
          { type: "input_text", text: "attached pixel.png" },
          { type: "input_image", image_url: `data:image/png;base64,${png}` },
        ],
      },
    },
    {
      name: "Azure Responses",
      provider: "azure-openai",
      adapter: (fetch) => new AzureOpenAIResponsesAdapter({ endpoint: "https://azure.example.test", apiKey: "offline", fetch }),
      select: (body) => (body.input as unknown[]).at(-1),
      expected: {
        type: "function_call_output",
        call_id: "read-image",
        output: [
          { type: "input_text", text: "attached pixel.png" },
          { type: "input_image", image_url: `data:image/png;base64,${png}` },
        ],
      },
    },
    {
      name: "Anthropic",
      provider: "anthropic",
      adapter: (fetch) => new AnthropicAdapter({ apiKey: "offline", fetch }),
      select: (body) => ((body.messages as Array<{ content: unknown[] }>).at(-1)?.content[0]),
      expected: {
        type: "tool_result",
        tool_use_id: "read-image",
        content: [
          { type: "text", text: "attached pixel.png" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        ],
        is_error: false,
      },
    },
    {
      name: "Gemini GenerateContent",
      provider: "gemini",
      adapter: (fetch) => new GeminiAdapter({ apiKey: "offline", fetch }),
      select: (body) => (body.contents as Array<{ parts: unknown[] }>).at(-1)?.parts,
      expected: [
        { functionResponse: { name: "read", response: { content: "attached pixel.png", isError: false } } },
        { inlineData: { mimeType: "image/png", data: png } },
      ],
    },
    {
      name: "Vertex GenerateContent",
      provider: "vertex",
      adapter: (fetch) => new VertexAdapter({ project: "offline-project", accessToken: "offline", fetch }),
      select: (body) => (body.contents as Array<{ parts: unknown[] }>).at(-1)?.parts,
      expected: [
        { functionResponse: { name: "read", response: { content: "attached pixel.png", isError: false } } },
        { inlineData: { mimeType: "image/png", data: png } },
      ],
    },
    {
      name: "Gemini Interactions",
      provider: "gemini",
      adapter: (fetch) => new GeminiInteractionsAdapter({ apiKey: "offline", fetch }),
      select: (body) => (body.input as unknown[]).at(-1),
      expected: {
        type: "function_result",
        call_id: "read-image",
        name: "read",
        result: [
          { type: "text", text: "attached pixel.png" },
          { type: "image", mime_type: "image/png", data: png },
        ],
        is_error: false,
      },
    },
    {
      name: "Bedrock Converse",
      provider: "bedrock",
      adapter: (fetch) => new BedrockAdapter({ region: "us-east-1", signer: (unsigned) => unsigned, fetch }),
      select: (body) => (body.messages as Array<{ content: unknown[] }>).at(-1)?.content[0],
      expected: {
        toolResult: {
          toolUseId: "read-image",
          content: [
            { text: "attached pixel.png" },
            { image: { format: "png", source: { bytes: png } } },
          ],
          status: "success",
        },
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let posted: Record<string, unknown> | undefined;
      const adapter = entry.adapter(fakeFetch(async (incoming) => {
        posted = await incoming.json() as Record<string, unknown>;
        return offlineFailure();
      }));
      await collect(adapter.stream(toolImageRequest(entry.provider, png), new AbortController().signal));
      assert.ok(posted);
      assert.deepEqual(entry.select(posted), entry.expected);
    });
  }
});

test("image/jpg aliases normalize consistently in data URLs and provider MIME fields", async () => {
  let posted: { input?: Array<{ content?: unknown }> } | undefined;
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "offline",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as { input?: Array<{ content?: unknown }> };
      return offlineFailure();
    }),
  });
  const providerRequest = imageRequest("openai", [
    { type: "image", mediaType: "image/jpg", url: "data:image/jpg;base64,AQID" },
  ]);

  await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.deepEqual(posted?.input?.[0]?.content, [
    { type: "input_text", text: "compare" },
    { type: "input_image", image_url: "data:image/jpeg;base64,AQID" },
  ]);
});

test("single-image validation enforces decoded, encoded, media-type, and URL boundaries", () => {
  assert.equal(MAX_IMAGE_BASE64_LENGTH, 4 * Math.ceil(MAX_IMAGE_BYTES / 3));
  const atLimit = `${"A".repeat(MAX_IMAGE_BASE64_LENGTH - 1)}=`;
  const normalized = normalizeImageSource(
    { type: "image", mediaType: "image/png", data: atLimit },
    "Boundary Test",
  );
  assert.equal(normalized.kind, "base64");
  assert.equal(normalized.kind === "base64" ? normalized.data.length : 0, MAX_IMAGE_BASE64_LENGTH);

  assert.throws(
    () => normalizeImageSource(
      { type: "image", mediaType: "image/png", data: "A".repeat(MAX_IMAGE_BASE64_LENGTH) },
      "Boundary Test",
    ),
    /decoded bytes/u,
  );
  assert.throws(
    () => normalizeImageSource(
      { type: "image", mediaType: "image/png", data: "A".repeat(MAX_IMAGE_BASE64_LENGTH + 4) },
      "Boundary Test",
    ),
    /encoded characters/u,
  );
  assert.throws(
    () => normalizeImageSource(
      { type: "image", mediaType: "image/png", url: `data:image/png;base64,${"A".repeat(MAX_IMAGE_BASE64_LENGTH + 4)}` },
      "Boundary Test",
    ),
    /encoded characters/u,
  );

  const urlPrefix = "https://images.example.test/";
  const boundedUrl = urlPrefix + "a".repeat(MAX_IMAGE_URL_LENGTH - urlPrefix.length);
  assert.equal(
    normalizeImageSource({ type: "image", mediaType: "image/png", url: boundedUrl }, "Boundary Test").kind,
    "url",
  );
  assert.throws(
    () => normalizeImageSource(
      { type: "image", mediaType: "image/png", url: `${boundedUrl}a` },
      "Boundary Test",
    ),
    /URL exceeds/u,
  );
  assert.throws(
    () => normalizeImageSource(
      { type: "image", mediaType: `image/${"a".repeat(MAX_IMAGE_MEDIA_TYPE_LENGTH)}`, data: "AQID" },
      "Boundary Test",
    ),
    /mediaType exceeds/u,
  );
});

test("every native adapter rejects an empty image before transport", async (t) => {
  const factories: Array<{ name: string; provider: ProviderId; adapter: AdapterFactory }> = [
    ...shapeCases.map(({ name, provider, adapter }) => ({ name, provider, adapter })),
    { name: "Ollama", provider: "ollama", adapter: (fetch) => new OllamaAdapter({ fetch }) },
  ];
  for (const entry of factories) {
    await t.test(entry.name, async () => {
      let fetches = 0;
      const adapter = entry.adapter(fakeFetch(() => {
        fetches += 1;
        return offlineFailure();
      }));
      const providerRequest = imageRequest(entry.provider, [{ type: "image", mediaType: "image/png" }]);

      const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
      assert.equal(fetches, 0);
      const failure = events.at(-1);
      assert.equal(failure?.type, "error");
      if (failure?.type === "error") {
        assert.equal(failure.error.category, "invalid_request");
        assert.equal(failure.error.retryable, false);
        assert.match(failure.error.message, /requires non-empty base64 data or a URL/u);
      }
    });
  }
});

test("image validation rejects ambiguous, malformed, and unsupported forms before transport", async (t) => {
  const cases: Array<{ name: string; adapter: AdapterFactory; provider: ProviderId; image: ImageBlock; pattern: RegExp }> = [
    {
      name: "data and URL together",
      provider: "openai",
      adapter: (fetch) => new OpenAIResponsesAdapter({ apiKey: "offline", fetch }),
      image: { type: "image", mediaType: "image/png", data: "AQID", url: "https://images.example.test/a.png" },
      pattern: /exactly one/u,
    },
    {
      name: "invalid base64",
      provider: "openai-compatible",
      adapter: (fetch) => new OpenAICompatibleAdapter({ baseUrl: "https://chat.example.test", fetch }),
      image: { type: "image", mediaType: "image/png", data: "not base64!" },
      pattern: /valid base64/u,
    },
    {
      name: "base64 with whitespace",
      provider: "ollama",
      adapter: (fetch) => new OllamaAdapter({ fetch }),
      image: { type: "image", mediaType: "image/png", data: " AQID " },
      pattern: /valid base64/u,
    },
    {
      name: "empty data URL payload",
      provider: "openai",
      adapter: (fetch) => new OpenAIResponsesAdapter({ apiKey: "offline", fetch }),
      image: { type: "image", mediaType: "image/png", url: "data:image/png;base64," },
      pattern: /valid base64/u,
    },
    {
      name: "data URL MIME mismatch",
      provider: "gemini",
      adapter: (fetch) => new GeminiAdapter({ apiKey: "offline", fetch }),
      image: { type: "image", mediaType: "image/jpeg", url: "data:image/png;base64,AQID" },
      pattern: /does not match/u,
    },
    {
      name: "Anthropic unsupported inline MIME",
      provider: "anthropic",
      adapter: (fetch) => new AnthropicAdapter({ apiKey: "offline", fetch }),
      image: { type: "image", mediaType: "image/svg+xml", data: "PHN2Zz4=" },
      pattern: /does not support image\/svg\+xml/u,
    },
    {
      name: "OpenAI Responses unsupported MIME",
      provider: "openai",
      adapter: (fetch) => new OpenAIResponsesAdapter({ apiKey: "offline", fetch }),
      image: { type: "image", mediaType: "image/svg+xml", data: "PHN2Zz4=" },
      pattern: /does not support image\/svg\+xml/u,
    },
    {
      name: "OpenAI Responses non-HTTP URL",
      provider: "openai",
      adapter: (fetch) => new OpenAIResponsesAdapter({ apiKey: "offline", fetch }),
      image: { type: "image", mediaType: "image/png", url: "file:///tmp/image.png" },
      pattern: /URL must use http: or https:/u,
    },
    {
      name: "Anthropic credential-bearing URL",
      provider: "anthropic",
      adapter: (fetch) => new AnthropicAdapter({ apiKey: "offline", fetch }),
      image: { type: "image", mediaType: "image/png", url: "https://user:secret@images.example.test/a.png" },
      pattern: /must not contain credentials/u,
    },
    {
      name: "OpenAI-compatible non-HTTP URL",
      provider: "openai-compatible",
      adapter: (fetch) => new OpenAICompatibleAdapter({ baseUrl: "https://chat.example.test", fetch }),
      image: { type: "image", mediaType: "image/png", url: "javascript:alert(1)" },
      pattern: /URL must use http: or https:/u,
    },
    {
      name: "Gemini non-HTTPS URI",
      provider: "gemini",
      adapter: (fetch) => new GeminiAdapter({ apiKey: "offline", fetch }),
      image: { type: "image", mediaType: "image/png", url: "http://images.example.test/a.png" },
      pattern: /URL must use https:/u,
    },
    {
      name: "Gemini Interactions relative file URI",
      provider: "gemini",
      adapter: (fetch) => new GeminiInteractionsAdapter({ apiKey: "offline", fetch }),
      image: { type: "image", mediaType: "image/png", url: "files/file-1" },
      pattern: /must be fully qualified/u,
    },
    {
      name: "Bedrock remote HTTP URL",
      provider: "bedrock",
      adapter: (fetch) => new BedrockAdapter({ region: "us-east-1", signer: (unsigned) => unsigned, fetch }),
      image: { type: "image", mediaType: "image/png", url: "https://images.example.test/a.png" },
      pattern: /does not support https: URL/u,
    },
    {
      name: "Bedrock invalid S3 URI",
      provider: "bedrock",
      adapter: (fetch) => new BedrockAdapter({ region: "us-east-1", signer: (unsigned) => unsigned, fetch }),
      image: { type: "image", mediaType: "image/png", url: "s3://Uppercase-Bucket/a.png" },
      pattern: /does not support s3: URL/u,
    },
    {
      name: "Bedrock oversized S3 URI",
      provider: "bedrock",
      adapter: (fetch) => new BedrockAdapter({ region: "us-east-1", signer: (unsigned) => unsigned, fetch }),
      image: { type: "image", mediaType: "image/png", url: `s3://offline-bucket/${"a".repeat(1_024)}` },
      pattern: /does not support s3: URL/u,
    },
    {
      name: "Ollama remote HTTP URL",
      provider: "ollama",
      adapter: (fetch) => new OllamaAdapter({ fetch }),
      image: { type: "image", mediaType: "image/png", url: "https://images.example.test/a.png" },
      pattern: /does not support https: URL/u,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let fetches = 0;
      const adapter = entry.adapter(fakeFetch(() => {
        fetches += 1;
        return offlineFailure();
      }));
      const events = await collect(adapter.stream(imageRequest(entry.provider, [entry.image]), new AbortController().signal));
      assert.equal(fetches, 0);
      const failure = events.at(-1);
      assert.equal(failure?.type, "error");
      if (failure?.type === "error") {
        assert.equal(failure.error.category, "invalid_request");
        assert.match(failure.error.message, entry.pattern);
      }
    });
  }
});

function imageRequest(provider: ProviderId, images: ImageBlock[]): ProviderRequest {
  const providerRequest = request(provider);
  providerRequest.messages[0]!.content = [{ type: "text", text: "compare" }, ...images];
  return providerRequest;
}

function toolImageRequest(provider: ProviderId, data: string): ProviderRequest {
  const providerRequest = request(provider);
  providerRequest.messages.push(
    {
      id: "assistant-tool-call",
      role: "assistant",
      content: [{ type: "tool_call", callId: "read-image", name: "read", arguments: { path: "pixel.png" } }],
      createdAt: "2026-07-09T00:00:01.000Z",
    },
    {
      id: "tool-image-result",
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId: "read-image",
          name: "read",
          content: "attached pixel.png",
          isError: false,
          images: [{ type: "image", mediaType: "image/png", data }],
        },
      ],
      createdAt: "2026-07-09T00:00:02.000Z",
    },
  );
  return providerRequest;
}

function offlineFailure(): Response {
  return new Response(JSON.stringify({ error: { message: "offline request-shape capture" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}
