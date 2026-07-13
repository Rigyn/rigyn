import type { ImageBlock } from "../core/types.js";
import type { OutboundImagePolicy } from "../core/types.js";
import type { QueueMode } from "../core/agent.js";

export const RPC_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const RPC_IMAGE_LIMITS = {
  maxCount: 20,
  maxBytesEach: 8 * 1024 * 1024,
  maxAggregateBytes: 16 * 1024 * 1024,
  maxUrlBytes: 16 * 1024,
} as const;

export const RPC_TOOL_SELECTION_LIMITS = {
  maxNamesEach: 256,
  maxAggregateBytes: 32 * 1024,
} as const;

export const RPC_MAX_COMPACTION_INSTRUCTIONS_BYTES = 16 * 1024;
export const RPC_MAX_REASONING_EFFORT_BYTES = 256;
export const RPC_SYSTEM_PROMPT_LIMITS = {
  maxBytesEach: 256 * 1024,
  maxAppendEntries: 32,
  maxAggregateBytes: 1024 * 1024,
} as const;

export const RPC_RUN_START_CAPABILITY = {
  images: {
    supported: true,
    mediaTypes: RPC_IMAGE_MEDIA_TYPES,
    sources: {
      base64: true,
      httpsUrl: true,
    },
    ...RPC_IMAGE_LIMITS,
  },
  allowedTools: true,
  excludedTools: true,
  noBuiltinTools: true,
  noContextFiles: true,
  systemPrompt: {
    supported: true,
    append: true,
    fileReferences: false,
    ...RPC_SYSTEM_PROMPT_LIMITS,
  },
  queueModes: ["one-at-a-time", "all"],
  summaryTokenBudget: true,
  reasoningEffortMaxBytes: RPC_MAX_REASONING_EFFORT_BYTES,
  providerOptionalWithModelReference: true,
  compactionInstructions: true,
  outboundImages: ["allow", "block"],
  manualCompaction: {
    supported: true,
    requiresExistingThread: true,
    acceptsPrompt: false,
    acceptsImages: false,
  },
} as const;

export interface ParsedRunStartInput {
  prompt: string;
  provider?: string;
  model: string;
  threadId?: string;
  branch?: string;
  images?: ImageBlock[];
  outboundImages?: OutboundImagePolicy;
  maxSteps?: number;
  maxOutputTokens?: number;
  contextTokenBudget?: number;
  summaryTokenBudget?: number;
  reasoningEffort?: string;
  allowedTools?: string[];
  excludedTools?: string[];
  noBuiltinTools?: boolean;
  noContextFiles?: boolean;
  systemPrompt?: { text: string; source: string };
  appendSystemPrompt?: Array<{ text: string; source: string }>;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  manualCompaction?: boolean;
  compactionInstructions?: string;
}

export interface ParsedQueuedRunInput {
  message: string;
  images?: ImageBlock[];
}

export function parseRunStartInput(input: Record<string, unknown>): ParsedRunStartInput {
  const allowedFields = new Set([
    "prompt", "provider", "model", "threadId", "branch", "images", "maxSteps",
    "maxOutputTokens", "contextTokenBudget", "summaryTokenBudget", "reasoningEffort",
    "allowedTools", "excludedTools", "noBuiltinTools", "noContextFiles", "systemPrompt",
    "appendSystemPrompt", "manualCompaction",
    "compactionInstructions", "steeringMode", "followUpMode", "outboundImages",
  ]);
  const unknownFields = Object.keys(input).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`run.start contains unknown fields: ${unknownFields.join(", ")}`);
  }
  const threadId = optionalString(input.threadId, "threadId");
  const branch = optionalString(input.branch, "branch");
  const provider = optionalString(input.provider, "provider");
  const model = requiredString(input.model, "model");
  const images = parseRpcImages(input.images);
  const manualCompaction = optionalBoolean(input.manualCompaction, "manualCompaction");
  const prompt = runPrompt(input.prompt, images, manualCompaction === true);

  if (manualCompaction === true && threadId === undefined) {
    throw new Error("manualCompaction requires an existing threadId");
  }

  const maxSteps = optionalPositiveInteger(input.maxSteps, "maxSteps");
  const maxOutputTokens = optionalPositiveInteger(input.maxOutputTokens, "maxOutputTokens");
  const contextTokenBudget = optionalPositiveInteger(input.contextTokenBudget, "contextTokenBudget");
  const summaryTokenBudget = optionalPositiveInteger(input.summaryTokenBudget, "summaryTokenBudget");
  const reasoningEffort = optionalReasoningEffort(input.reasoningEffort);
  const allowedTools = toolNames(input.allowedTools, "allowedTools");
  const excludedTools = toolNames(input.excludedTools, "excludedTools");
  const noBuiltinTools = optionalBoolean(input.noBuiltinTools, "noBuiltinTools");
  const noContextFiles = optionalBoolean(input.noContextFiles, "noContextFiles");
  const promptCustomization = parseSystemPromptCustomization(input.systemPrompt, input.appendSystemPrompt);
  const steeringMode = optionalQueueMode(input.steeringMode, "steeringMode");
  const followUpMode = optionalQueueMode(input.followUpMode, "followUpMode");
  const compactionInstructions = boundedInstructions(input.compactionInstructions);
  const outboundImages = optionalOutboundImages(input.outboundImages);
  if (manualCompaction === true && (promptCustomization.systemPrompt !== undefined || promptCustomization.appendSystemPrompt !== undefined)) {
    throw new Error("manualCompaction does not accept system-prompt customizations");
  }

  return {
    prompt,
    ...(provider === undefined ? {} : { provider }),
    model,
    ...(threadId === undefined ? {} : { threadId }),
    ...(branch === undefined ? {} : { branch }),
    ...(images === undefined ? {} : { images }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(contextTokenBudget === undefined ? {} : { contextTokenBudget }),
    ...(summaryTokenBudget === undefined ? {} : { summaryTokenBudget }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(excludedTools === undefined ? {} : { excludedTools }),
    ...(noBuiltinTools === undefined ? {} : { noBuiltinTools }),
    ...(noContextFiles === undefined ? {} : { noContextFiles }),
    ...promptCustomization,
    ...(steeringMode === undefined ? {} : { steeringMode }),
    ...(followUpMode === undefined ? {} : { followUpMode }),
    ...(manualCompaction === undefined ? {} : { manualCompaction }),
    ...(compactionInstructions === undefined ? {} : { compactionInstructions }),
    ...(outboundImages === undefined ? {} : { outboundImages }),
  };
}

function parseSystemPromptCustomization(
  systemPromptValue: unknown,
  appendSystemPromptValue: unknown,
): Pick<ParsedRunStartInput, "systemPrompt" | "appendSystemPrompt"> {
  const systemPrompt = promptText(systemPromptValue, "systemPrompt");
  if (appendSystemPromptValue !== undefined && !Array.isArray(appendSystemPromptValue)) {
    throw new Error("appendSystemPrompt must be an array of strings");
  }
  const appendValues = appendSystemPromptValue as unknown[] | undefined;
  if ((appendValues?.length ?? 0) > RPC_SYSTEM_PROMPT_LIMITS.maxAppendEntries) {
    throw new Error(`appendSystemPrompt may contain at most ${RPC_SYSTEM_PROMPT_LIMITS.maxAppendEntries} entries`);
  }
  const appendSystemPrompt = (appendValues ?? []).map((value, index) => ({
    text: promptText(value, `appendSystemPrompt[${index}]`, false)!,
    source: `rpc appendSystemPrompt #${index + 1}`,
  }));
  const aggregateBytes = (systemPrompt === undefined ? 0 : Buffer.byteLength(systemPrompt, "utf8")) +
    appendSystemPrompt.reduce((total, entry) => total + Buffer.byteLength(entry.text, "utf8"), 0);
  if (aggregateBytes > RPC_SYSTEM_PROMPT_LIMITS.maxAggregateBytes) {
    throw new Error(`system-prompt customizations exceed ${RPC_SYSTEM_PROMPT_LIMITS.maxAggregateBytes} aggregate bytes`);
  }
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt: { text: systemPrompt, source: "rpc systemPrompt" } }),
    ...(appendSystemPrompt.length === 0 ? {} : { appendSystemPrompt }),
  };
}

function promptText(value: unknown, label: string, optional = true): string | undefined {
  if (value === undefined && optional) return undefined;
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > RPC_SYSTEM_PROMPT_LIMITS.maxBytesEach
  ) {
    throw new Error(`${label} must contain 1 to ${RPC_SYSTEM_PROMPT_LIMITS.maxBytesEach} bytes without NUL`);
  }
  return value;
}

export function parseQueuedRunInput(input: Record<string, unknown>): ParsedQueuedRunInput {
  const allowedFields = new Set(["threadId", "message", "images"]);
  const unknownFields = Object.keys(input).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`queued run input contains unknown fields: ${unknownFields.join(", ")}`);
  }
  const images = parseRpcImages(input.images);
  const message = runPrompt(input.message, images, false);
  return {
    message,
    ...(images === undefined ? {} : { images }),
  };
}

function runPrompt(value: unknown, images: ImageBlock[] | undefined, manualCompaction: boolean): string {
  if (manualCompaction) {
    if (value !== undefined && value !== "") {
      throw new Error("manualCompaction does not accept a prompt; use an empty string or omit prompt");
    }
    if ((images?.length ?? 0) > 0) throw new Error("manualCompaction does not accept images");
    return "";
  }
  if (value === undefined && (images?.length ?? 0) > 0) return "";
  if (typeof value !== "string") throw new Error("prompt is required");
  if (value === "" && (images?.length ?? 0) === 0) throw new Error("prompt or at least one image is required");
  return value;
}

export function parseRpcImages(value: unknown): ImageBlock[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("images must be an array");
  if (value.length > RPC_IMAGE_LIMITS.maxCount) {
    throw new Error(`images may contain at most ${RPC_IMAGE_LIMITS.maxCount} entries`);
  }

  const images: ImageBlock[] = [];
  let aggregateBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const parsed = imageBlock(value[index], index);
    aggregateBytes += parsed.bytes;
    if (aggregateBytes > RPC_IMAGE_LIMITS.maxAggregateBytes) {
      throw new Error(`images exceed ${RPC_IMAGE_LIMITS.maxAggregateBytes} aggregate bytes`);
    }
    images.push(parsed.block);
  }
  return images;
}

function imageBlock(value: unknown, index: number): { block: ImageBlock; bytes: number } {
  const label = `images[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["type", "mediaType", "data", "url"]);
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) throw new Error(`${label} contains unknown fields: ${unknownKeys.join(", ")}`);
  if (record.type !== "image") throw new Error(`${label}.type must be image`);
  if (typeof record.mediaType !== "string" || !RPC_IMAGE_MEDIA_TYPES.includes(record.mediaType as typeof RPC_IMAGE_MEDIA_TYPES[number])) {
    throw new Error(`${label}.mediaType must be one of ${RPC_IMAGE_MEDIA_TYPES.join(", ")}`);
  }

  const hasData = Object.hasOwn(record, "data");
  const hasUrl = Object.hasOwn(record, "url");
  if (hasData === hasUrl) throw new Error(`${label} must contain exactly one of data or url`);
  const mediaType = record.mediaType;
  if (hasData) {
    if (typeof record.data !== "string") throw new Error(`${label}.data must be a base64 string`);
    const bytes = base64Bytes(record.data, label);
    return { block: { type: "image", mediaType, data: record.data }, bytes };
  }
  if (typeof record.url !== "string") throw new Error(`${label}.url must be a string`);
  const bytes = httpsUrlBytes(record.url, label);
  return { block: { type: "image", mediaType, url: record.url }, bytes };
}

function base64Bytes(value: string, label: string): number {
  const maxEncodedBytes = Math.ceil(RPC_IMAGE_LIMITS.maxBytesEach / 3) * 4;
  if (value === "" || Buffer.byteLength(value, "utf8") > maxEncodedBytes) {
    throw new Error(`${label}.data must encode 1 to ${RPC_IMAGE_LIMITS.maxBytesEach} bytes`);
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length % 4 !== 0 || !base64Characters(value, value.length - padding)) {
    throw new Error(`${label}.data must be canonical base64 without whitespace`);
  }
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes < 1 || decodedBytes > RPC_IMAGE_LIMITS.maxBytesEach) {
    throw new Error(`${label}.data must encode 1 to ${RPC_IMAGE_LIMITS.maxBytesEach} bytes`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== decodedBytes || decoded.toString("base64") !== value) {
    throw new Error(`${label}.data must be canonical base64 without whitespace`);
  }
  return decoded.length;
}

function base64Characters(value: string, contentLength: number): boolean {
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code < 65 || code > 90) &&
      (code < 97 || code > 122) &&
      (code < 48 || code > 57) &&
      code !== 43 &&
      code !== 47
    ) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function httpsUrlBytes(value: string, label: string): number {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > RPC_IMAGE_LIMITS.maxUrlBytes || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label}.url must contain 1 to ${RPC_IMAGE_LIMITS.maxUrlBytes} bytes without whitespace or control characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label}.url must be a fully qualified HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname === "") throw new Error(`${label}.url must be a fully qualified HTTPS URL`);
  if (parsed.username !== "" || parsed.password !== "") throw new Error(`${label}.url must not contain credentials`);
  return bytes;
}

function toolNames(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of tool names`);
  if (value.length > RPC_TOOL_SELECTION_LIMITS.maxNamesEach) {
    throw new Error(`${label} may contain at most ${RPC_TOOL_SELECTION_LIMITS.maxNamesEach} names`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  let aggregateBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const name = value[index];
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(name)) {
      throw new Error(`${label}[${index}] is not a valid tool name`);
    }
    if (seen.has(name)) throw new Error(`${label} contains duplicate tool name ${name}`);
    seen.add(name);
    aggregateBytes += Buffer.byteLength(name, "utf8");
    if (aggregateBytes > RPC_TOOL_SELECTION_LIMITS.maxAggregateBytes) {
      throw new Error(`${label} exceeds ${RPC_TOOL_SELECTION_LIMITS.maxAggregateBytes} aggregate bytes`);
    }
    result.push(name);
  }
  return result;
}

function boundedInstructions(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value, "utf8") > RPC_MAX_COMPACTION_INSTRUCTIONS_BYTES) {
    throw new Error(`compactionInstructions must contain 1 to ${RPC_MAX_COMPACTION_INSTRUCTIONS_BYTES} bytes`);
  }
  return value;
}

function optionalReasoningEffort(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > RPC_MAX_REASONING_EFFORT_BYTES
  ) {
    throw new Error(`reasoningEffort must contain 1 to ${RPC_MAX_REASONING_EFFORT_BYTES} bytes without NUL`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalQueueMode(value: unknown, label: string): QueueMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "all" && value !== "one-at-a-time") throw new Error(`${label} must be all or one-at-a-time`);
  return value;
}

export function optionalOutboundImages(value: unknown, label = "outboundImages"): OutboundImagePolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== "allow" && value !== "block") throw new Error(`${label} must be allow or block`);
  return value;
}
