import assert from "node:assert/strict";
import test from "node:test";

import {
  parseQueuedRunInput,
  parseRunStartInput,
  RPC_IMAGE_LIMITS,
  RPC_IMAGE_MEDIA_TYPES,
  RPC_MAX_COMPACTION_INSTRUCTIONS_BYTES,
  RPC_MAX_REASONING_EFFORT_BYTES,
  RPC_RUN_START_CAPABILITY,
  RPC_SYSTEM_PROMPT_LIMITS,
} from "../../src/interfaces/run-input.js";

const DATA_IMAGE = { type: "image", mediaType: "image/png", data: "iVBORw==" } as const;

test("queued run input accepts bounded captions or image-only messages", () => {
  assert.deepEqual(parseQueuedRunInput({
    threadId: "thread_existing",
    message: "look here",
    images: [DATA_IMAGE],
  }), { message: "look here", images: [DATA_IMAGE] });
  assert.deepEqual(parseQueuedRunInput({
    threadId: "thread_existing",
    images: [DATA_IMAGE],
  }), { message: "", images: [DATA_IMAGE] });
  assert.throws(() => parseQueuedRunInput({ threadId: "thread_existing", message: "" }), /prompt or at least one image/u);
  assert.throws(() => parseQueuedRunInput({
    threadId: "thread_existing",
    message: "look",
    images: [{ ...DATA_IMAGE, data: "not base64" }],
  }), /canonical base64/u);
  assert.throws(() => parseQueuedRunInput({
    threadId: "thread_existing",
    message: "look",
    extra: true,
  }), /unknown fields: extra/u);
});

test("run.start input parsing preserves every supported option and canonical image source", () => {
  assert.deepEqual(parseRunStartInput({
    threadId: "thread_existing",
    branch: "feature",
    prompt: "compare these images",
    provider: "offline",
    model: "model",
    images: [
      DATA_IMAGE,
      { type: "image", mediaType: "image/jpeg", url: "https://images.example.test/photo.jpg" },
    ],
    maxSteps: 7,
    maxOutputTokens: 512,
    contextTokenBudget: 8_192,
    summaryTokenBudget: 256,
    reasoningEffort: "medium",
    allowedTools: ["read", "extension.lookup"],
    excludedTools: ["write"],
    noBuiltinTools: false,
    noContextFiles: true,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    outboundImages: "block",
    manualCompaction: false,
    compactionInstructions: "Preserve exact filenames.",
  }), {
    prompt: "compare these images",
    provider: "offline",
    model: "model",
    threadId: "thread_existing",
    branch: "feature",
    images: [
      DATA_IMAGE,
      { type: "image", mediaType: "image/jpeg", url: "https://images.example.test/photo.jpg" },
    ],
    maxSteps: 7,
    maxOutputTokens: 512,
    contextTokenBudget: 8_192,
    summaryTokenBudget: 256,
    reasoningEffort: "medium",
    allowedTools: ["read", "extension.lookup"],
    excludedTools: ["write"],
    noBuiltinTools: false,
    noContextFiles: true,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    outboundImages: "block",
    manualCompaction: false,
    compactionInstructions: "Preserve exact filenames.",
  });
  assert.equal(parseRunStartInput({
    provider: "offline",
    model: "model",
    images: [DATA_IMAGE],
  }).prompt, "");
});

test("run.start image parsing rejects unknown, ambiguous, malformed, and unsafe shapes", () => {
  const cases: Array<{ input: unknown; pattern: RegExp }> = [
    { input: "image", pattern: /must be an array/u },
    { input: [null], pattern: /must be an object/u },
    { input: [{ ...DATA_IMAGE, alt: "pixel" }], pattern: /unknown fields: alt/u },
    { input: [{ ...DATA_IMAGE, type: "input_image" }], pattern: /type must be image/u },
    { input: [{ ...DATA_IMAGE, mediaType: "image/svg+xml" }], pattern: /mediaType must be one of/u },
    { input: [{ type: "image", mediaType: "image/png" }], pattern: /exactly one/u },
    {
      input: [{ ...DATA_IMAGE, url: "https://images.example.test/pixel.png" }],
      pattern: /exactly one/u,
    },
    { input: [{ ...DATA_IMAGE, data: "not base64" }], pattern: /canonical base64/u },
    { input: [{ ...DATA_IMAGE, data: "AQ" }], pattern: /canonical base64/u },
    { input: [{ type: "image", mediaType: "image/png", url: "http://images.example.test/pixel.png" }], pattern: /HTTPS URL/u },
    { input: [{ type: "image", mediaType: "image/png", url: "file:///tmp/pixel.png" }], pattern: /HTTPS URL/u },
    {
      input: [{ type: "image", mediaType: "image/png", url: "https://user:secret@images.example.test/pixel.png" }],
      pattern: /must not contain credentials/u,
    },
  ];
  for (const entry of cases) {
    assert.throws(() => parseRunStartInput({
      prompt: "inspect",
      provider: "offline",
      model: "model",
      images: entry.input,
    }), entry.pattern);
  }
});

test("run.start image parsing enforces count, per-image, and aggregate byte ceilings", () => {
  assert.throws(() => parseRunStartInput({
    prompt: "inspect",
    provider: "offline",
    model: "model",
    images: Array.from({ length: RPC_IMAGE_LIMITS.maxCount + 1 }, () => DATA_IMAGE),
  }), /at most 20 entries/u);

  const oversized = Buffer.alloc(RPC_IMAGE_LIMITS.maxBytesEach + 1).toString("base64");
  assert.throws(() => parseRunStartInput({
    prompt: "inspect",
    provider: "offline",
    model: "model",
    images: [{ type: "image", mediaType: "image/png", data: oversized }],
  }), new RegExp(`1 to ${RPC_IMAGE_LIMITS.maxBytesEach} bytes`, "u"));

  const maximum = Buffer.alloc(RPC_IMAGE_LIMITS.maxBytesEach).toString("base64");
  assert.throws(() => parseRunStartInput({
    prompt: "inspect",
    provider: "offline",
    model: "model",
    images: [
      { type: "image", mediaType: "image/png", data: maximum },
      { type: "image", mediaType: "image/jpeg", data: maximum },
      DATA_IMAGE,
    ],
  }), new RegExp(`exceed ${RPC_IMAGE_LIMITS.maxAggregateBytes} aggregate bytes`, "u"));
});

test("run.start option parsing is strict and manual compaction cannot discard new input", () => {
  const base = { prompt: "inspect", provider: "offline", model: "model" };
  assert.throws(() => parseRunStartInput({ ...base, unsupportedOption: true }), /unknown fields: unsupportedOption/u);
  assert.throws(() => parseRunStartInput({ ...base, allowedTools: "read" }), /allowedTools must be an array/u);
  assert.throws(() => parseRunStartInput({ ...base, allowedTools: ["read", "read"] }), /duplicate tool name read/u);
  assert.throws(() => parseRunStartInput({ ...base, excludedTools: ["bad name"] }), /not a valid tool name/u);
  assert.throws(() => parseRunStartInput({ ...base, noBuiltinTools: "yes" }), /must be a boolean/u);
  assert.throws(() => parseRunStartInput({ ...base, noContextFiles: "yes" }), /must be a boolean/u);
  assert.throws(() => parseRunStartInput({ ...base, steeringMode: "batch" }), /steeringMode must be/u);
  assert.throws(() => parseRunStartInput({ ...base, followUpMode: "batch" }), /followUpMode must be/u);
  assert.throws(() => parseRunStartInput({ ...base, outboundImages: "redact" }), /outboundImages must be allow or block/u);
  assert.throws(() => parseRunStartInput({ ...base, summaryTokenBudget: 0 }), /positive integer/u);
  assert.throws(() => parseRunStartInput({
    ...base,
    reasoningEffort: "x".repeat(RPC_MAX_REASONING_EFFORT_BYTES + 1),
  }), /1 to 256 bytes/u);
  assert.throws(() => parseRunStartInput({ ...base, compactionInstructions: " " }), /1 to 16384 bytes/u);
  assert.throws(() => parseRunStartInput({
    ...base,
    compactionInstructions: "a".repeat(RPC_MAX_COMPACTION_INSTRUCTIONS_BYTES + 1),
  }), /1 to 16384 bytes/u);
  assert.throws(() => parseRunStartInput({ provider: "offline", model: "model", manualCompaction: true }), /existing threadId/u);
  assert.throws(() => parseRunStartInput({ ...base, threadId: "thread_existing", manualCompaction: true }), /does not accept a prompt/u);
  assert.throws(() => parseRunStartInput({
    provider: "offline",
    model: "model",
    threadId: "thread_existing",
    manualCompaction: true,
    images: [DATA_IMAGE],
  }), /does not accept images/u);
  assert.deepEqual(parseRunStartInput({
    provider: "offline",
    model: "model",
    threadId: "thread_existing",
    manualCompaction: true,
    summaryTokenBudget: 64,
    compactionInstructions: "Keep unresolved work.",
  }), {
    prompt: "",
    provider: "offline",
    model: "model",
    threadId: "thread_existing",
    summaryTokenBudget: 64,
    manualCompaction: true,
    compactionInstructions: "Keep unresolved work.",
  });
  assert.deepEqual(RPC_IMAGE_MEDIA_TYPES, ["image/png", "image/jpeg", "image/gif", "image/webp"]);
  assert.deepEqual(parseRunStartInput({
    prompt: "canonical selection",
    model: "selection-provider/coder-v1:high",
  }), {
    prompt: "canonical selection",
    model: "selection-provider/coder-v1:high",
  });
  assert.equal(RPC_RUN_START_CAPABILITY.providerOptionalWithModelReference, true);
  assert.equal(RPC_RUN_START_CAPABILITY.noContextFiles, true);
});

test("run.start accepts bounded inline system-prompt customizations without file semantics", () => {
  assert.deepEqual(parseRunStartInput({
    prompt: "inspect",
    provider: "offline",
    model: "model",
    systemPrompt: "Operate from RPC.",
    appendSystemPrompt: ["Keep exact paths.", "Report verification."],
  }), {
    prompt: "inspect",
    provider: "offline",
    model: "model",
    systemPrompt: { text: "Operate from RPC.", source: "rpc systemPrompt" },
    appendSystemPrompt: [
      { text: "Keep exact paths.", source: "rpc appendSystemPrompt #1" },
      { text: "Report verification.", source: "rpc appendSystemPrompt #2" },
    ],
  });
  const base = { prompt: "inspect", provider: "offline", model: "model" };
  assert.throws(() => parseRunStartInput({ ...base, systemPrompt: "" }), /systemPrompt must contain/u);
  assert.throws(() => parseRunStartInput({ ...base, appendSystemPrompt: "text" }), /must be an array/u);
  assert.throws(() => parseRunStartInput({ ...base, appendSystemPrompt: [undefined] }), /appendSystemPrompt\[0\] must contain/u);
  assert.throws(() => parseRunStartInput({
    ...base,
    appendSystemPrompt: Array.from({ length: RPC_SYSTEM_PROMPT_LIMITS.maxAppendEntries + 1 }, () => "text"),
  }), /at most 32 entries/u);
  assert.throws(() => parseRunStartInput({
    ...base,
    systemPrompt: "x".repeat(RPC_SYSTEM_PROMPT_LIMITS.maxBytesEach + 1),
  }), /1 to 262144 bytes/u);
  assert.throws(() => parseRunStartInput({
    provider: "offline",
    model: "model",
    threadId: "thread_existing",
    manualCompaction: true,
    systemPrompt: "ignored",
  }), /does not accept system-prompt/u);
  assert.equal(RPC_RUN_START_CAPABILITY.systemPrompt.fileReferences, false);
});
