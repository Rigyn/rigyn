import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock as BedrockContentBlock,
  type ConverseStreamOutput,
  type TokenUsage,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  Provider,
  SimpleStreamOptions,
  ThinkingLevel,
  ToolResultMessage,
} from "./contracts.js";
import { createAssistantMessageEventStream, emptyUsage } from "./streaming.js";
import { calculateCost, errorMessage } from "./utilities.js";

const MAX_ASSISTANT_BLOCKS = 1_024;
const MAX_ASSISTANT_FIELD_BYTES = 4 * 1024 * 1024;
const MAX_ASSISTANT_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_CALL_ID_BYTES = 1_024;
const MAX_TOOL_CALL_NAME_BYTES = 256;
const MAX_TOOL_ARGUMENT_VALUES = 8_192;
const MAX_TOOL_ARGUMENT_CONTAINERS = 8_192;
const MAX_TOOL_ARGUMENT_DEPTH = 59;
const EMPTY_TOOL_ARGUMENT_BYTES = 2;
const MAX_BEDROCK_IMAGES = 20;
const MAX_BEDROCK_IMAGE_BYTES = 15 * 1024 * 1024 / 4;
const MAX_BEDROCK_IMAGE_BASE64_LENGTH = 4 * Math.ceil(MAX_BEDROCK_IMAGE_BYTES / 3);
const CURRENT_REASONING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const utf8Encoder = new TextEncoder();

interface BedrockContentBudget {
  contentBytes: number;
  fieldBytes: Map<number, number>;
  providerExtraBytes: number;
  providerExtraByWire: Map<number, number>;
  blockKinds: Map<number, "text" | "thinking" | "tool">;
  closedBlocks: Set<number>;
}

interface BedrockToolState {
  contentIndex: number;
  raw: string;
  rawBytes: number;
}

interface BedrockImageBudget {
  count: number;
}

type BedrockTextImageBlock =
  | { text: string }
  | { image: {
    format: "png" | "jpeg" | "gif" | "webp";
    source: { bytes: Uint8Array };
  } };

function snapshotAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => block.type === "toolCall"
      ? { ...block, arguments: structuredClone(block.arguments) }
      : { ...block }),
    usage: {
      ...message.usage,
      ...(message.usage.cost === undefined ? {} : { cost: { ...message.usage.cost } }),
    },
    ...(message.diagnostics === undefined ? {} : { diagnostics: structuredClone(message.diagnostics) }),
    ...(message.providerState === undefined ? {} : { providerState: structuredClone(message.providerState) }),
  };
}

function byteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function requiredToolIdentity(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string" || value === "" || byteLength(value) > maximumBytes ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) throw new TypeError(`Invalid ${label}`);
  return value;
}

function canonicalToolArguments(raw: string): { value: Record<string, unknown>; bytes: number } {
  let parsed: unknown = {};
  if (raw.trim()) {
    try { parsed = JSON.parse(raw); } catch { throw new TypeError("Tool arguments must be a valid JSON object"); }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Tool arguments must be a valid JSON object");
  }
  const serialized = JSON.stringify(parsed);
  const bytes = byteLength(serialized);
  if (bytes > MAX_ASSISTANT_FIELD_BYTES) throw new RangeError("Tool arguments exceeded 4 MiB");
  validateToolArgumentComplexity(parsed as Record<string, unknown>);
  return { value: parsed as Record<string, unknown>, bytes };
}

function validateToolArgumentComplexity(value: Record<string, unknown>): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let values = 0;
  let containers = 0;
  while (pending.length > 0) {
    const selected = pending.pop();
    if (selected === undefined) break;
    values += 1;
    if (values > MAX_TOOL_ARGUMENT_VALUES) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_VALUES} JSON values`);
    }
    if (selected.depth > MAX_TOOL_ARGUMENT_DEPTH) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_DEPTH} levels`);
    }
    if (selected.value === null || typeof selected.value !== "object") continue;
    containers += 1;
    if (containers > MAX_TOOL_ARGUMENT_CONTAINERS) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_CONTAINERS} JSON containers`);
    }
    const children = Array.isArray(selected.value) ? selected.value : Object.values(selected.value);
    if (children.length > MAX_TOOL_ARGUMENT_VALUES - values - pending.length) {
      throw new RangeError(`Tool arguments exceeded ${MAX_TOOL_ARGUMENT_VALUES} JSON values`);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ value: children[index], depth: selected.depth + 1 });
    }
  }
}

function setProviderBlock(
  blocks: Map<number, BedrockContentBlock>,
  index: number,
  block: BedrockContentBlock,
): void {
  if (!blocks.has(index) && blocks.size >= MAX_ASSISTANT_BLOCKS) {
    throw new RangeError(`Assistant content exceeded ${MAX_ASSISTANT_BLOCKS} blocks`);
  }
  blocks.set(index, block);
}

function bedrockWireIndex(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected >= MAX_ASSISTANT_BLOCKS) {
    throw new RangeError(`Bedrock content-block index must be below ${MAX_ASSISTANT_BLOCKS}`);
  }
  return selected;
}

function enterBedrockBlock(
  budget: BedrockContentBudget,
  wireIndex: number,
  kind: "text" | "thinking" | "tool",
): void {
  if (budget.closedBlocks.has(wireIndex)) throw new TypeError("Bedrock emitted content after contentBlockStop");
  const current = budget.blockKinds.get(wireIndex);
  if (current !== undefined && current !== kind) {
    throw new TypeError("Bedrock changed a content block's type while streaming");
  }
  budget.blockKinds.set(wireIndex, kind);
}

function setProviderExtraBytes(budget: BedrockContentBudget, wireIndex: number, nextBytes: number): void {
  const previousBytes = budget.providerExtraByWire.get(wireIndex) ?? 0;
  const retainedBytes = budget.contentBytes + budget.providerExtraBytes - previousBytes;
  if (nextBytes > MAX_ASSISTANT_CONTENT_BYTES - retainedBytes) {
    throw new RangeError("Assistant content exceeded 8 MiB");
  }
  budget.providerExtraBytes = budget.providerExtraBytes - previousBytes + nextBytes;
  if (nextBytes === 0) budget.providerExtraByWire.delete(wireIndex);
  else budget.providerExtraByWire.set(wireIndex, nextBytes);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tokenSum(...values: number[]): number | undefined {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function bedrockImageFormat(mimeType: string): "png" | "jpeg" | "gif" | "webp" {
  if (mimeType !== mimeType.trim()) throw new TypeError("Bedrock images require a supported MIME type");
  switch (mimeType.toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg":
    case "image/jpg": return "jpeg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: throw new TypeError("Bedrock images require a supported MIME type: image/png, image/jpeg, image/gif, or image/webp");
  }
}

function bedrockImageContent(
  image: ImageContent,
  model: Model<"bedrock-converse-stream">,
  budget: BedrockImageBudget,
): BedrockTextImageBlock {
  if (typeof image.mimeType !== "string" || typeof image.data !== "string") {
    throw new TypeError("Bedrock image content requires string mimeType and data fields");
  }
  if (!model.input.includes("image")) throw new TypeError(`Model ${model.id} does not accept image input`);
  budget.count += 1;
  if (budget.count > MAX_BEDROCK_IMAGES) {
    throw new RangeError(`Bedrock requests accept at most ${MAX_BEDROCK_IMAGES} images`);
  }
  const format = bedrockImageFormat(image.mimeType);
  if (
    image.data === "" || image.data.length > MAX_BEDROCK_IMAGE_BASE64_LENGTH ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(image.data)
  ) {
    if (image.data.length > MAX_BEDROCK_IMAGE_BASE64_LENGTH) {
      throw new RangeError("Bedrock image data must not exceed 3.75 MiB");
    }
    throw new TypeError("Bedrock image data must be non-empty canonical base64 without whitespace");
  }
  let bytes: Uint8Array;
  try {
    const decoded = atob(image.data);
    if (btoa(decoded) !== image.data) {
      throw new TypeError("Image data was not canonical base64");
    }
    bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  } catch {
    throw new TypeError("Bedrock image data must be non-empty canonical base64 without whitespace");
  }
  if (bytes.byteLength > MAX_BEDROCK_IMAGE_BYTES) {
    throw new RangeError("Bedrock image data must not exceed 3.75 MiB");
  }
  return { image: { format, source: { bytes } } };
}

function bedrockUserContent(
  content: unknown,
  model: Model<"bedrock-converse-stream">,
  budget: BedrockImageBudget,
  label = "user",
): BedrockTextImageBlock[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) throw new TypeError(`Bedrock ${label} content must be a string or content-block array`);
  return content.map((part) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      throw new TypeError(`Invalid Bedrock ${label} content block`);
    }
    const block = part as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") return { text: block.text };
    if (block.type === "image") return bedrockImageContent(block as unknown as ImageContent, model, budget);
    throw new TypeError(`Invalid Bedrock ${label} content block`);
  });
}

function bedrockToolResultBlock(
  message: ToolResultMessage,
  model: Model<"bedrock-converse-stream">,
  budget: BedrockImageBudget,
): BedrockContentBlock {
  const toolUseId = requiredToolIdentity(message.toolCallId, "tool-call ID", MAX_TOOL_CALL_ID_BYTES);
  if (!Array.isArray(message.content)) throw new TypeError("Bedrock tool-result content must be a content-block array");
  if (typeof message.isError !== "boolean") throw new TypeError("Bedrock tool-result isError must be boolean");
  const content = bedrockUserContent(message.content, model, budget, "tool-result")
    .filter((block) => !("text" in block) || block.text.trim() !== "");
  return { toolResult: {
    toolUseId,
    content: content.length === 0 ? [{ text: "<empty>" }] : content,
    status: message.isError ? "error" : "success",
  } };
}

function bedrockMessages(
  context: Context,
  model: Model<"bedrock-converse-stream">,
  imageBudget: BedrockImageBudget,
): Array<{ role: "assistant" | "user"; content: BedrockContentBlock[] }> {
  const messages: Array<{ role: "assistant" | "user"; content: BedrockContentBlock[] }> = [];
  for (let index = 0; index < context.messages.length; index += 1) {
    const message = context.messages[index]!;
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: bedrockAssistantContent(message, model) });
      continue;
    }
    if (message.role === "toolResult") {
      const content: BedrockContentBlock[] = [];
      let cursor = index;
      while (context.messages[cursor]?.role === "toolResult") {
        content.push(bedrockToolResultBlock(context.messages[cursor] as ToolResultMessage, model, imageBudget));
        cursor += 1;
      }
      messages.push({ role: "user", content });
      index = cursor - 1;
      continue;
    }
    messages.push({ role: "user", content: bedrockUserContent(message.content, model, imageBudget) });
  }
  return messages;
}

export interface BedrockTransportOptions {
  client?: BedrockRuntimeClient;
  region?: string;
  clientConfig?: ConstructorParameters<typeof BedrockRuntimeClient>[0];
}

export function createBedrockConverseTransport(configuration: BedrockTransportOptions = {}) {
  const client = configuration.client ?? new BedrockRuntimeClient({
    ...configuration.clientConfig,
    ...(configuration.region === undefined ? {} : { region: configuration.region }),
  });
  return (model: Model<"bedrock-converse-stream">, context: Context, options: SimpleStreamOptions = {}): AssistantMessageEventStream => {
    const cancellation = new AbortController();
    const signal = options.signal === undefined
      ? cancellation.signal
      : AbortSignal.any([options.signal, cancellation.signal]);
    const stream = createAssistantMessageEventStream(() => {
      cancellation.abort(new DOMException("Stream consumer cancelled", "AbortError"));
    });
    const message: AssistantMessage = {
      role: "assistant" as const,
      content: [] as Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }>,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
      errorMessage: undefined as string | undefined,
    };
    const snapshot = () => snapshotAssistantMessage(message);
    stream.push({ type: "start", partial: snapshot() });
    void (async () => {
      if (options.reasoning !== undefined && !CURRENT_REASONING_LEVELS.has(options.reasoning)) {
        throw new RangeError(`Reasoning level must be one of: ${[...CURRENT_REASONING_LEVELS].join(", ")}`);
      }
      const additionalModelRequestFields = bedrockThinkingFields(model, options, configuration.region);
      const showReasoningSummary = (
        additionalModelRequestFields?.thinking as { display?: unknown } | undefined
      )?.display === "summarized";
      const imageBudget: BedrockImageBudget = { count: 0 };
      const command = new ConverseStreamCommand({
        modelId: model.id,
        messages: bedrockMessages(context, model, imageBudget),
        ...(context.systemPrompt ? { system: [{ text: context.systemPrompt }] } : {}),
        inferenceConfig: {
          ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
          ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        },
        ...(context.tools?.length ? { toolConfig: { tools: context.tools.map((tool) => ({ toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { json: structuredClone(tool.parameters) as never },
        } })) } } : {}),
        ...(additionalModelRequestFields === undefined ? {} : { additionalModelRequestFields: additionalModelRequestFields as never }),
      });
      const response = await client.send(command, { abortSignal: signal });
      if (!response.stream) throw new Error("Bedrock ConverseStream returned no stream");
      const tools = new Map<number, BedrockToolState>();
      const texts = new Map<number, number>();
      const thinking = new Map<number, number>();
      const providerBlocks = new Map<number, BedrockContentBlock>();
      const budget: BedrockContentBudget = {
        contentBytes: 0,
        fieldBytes: new Map(),
        providerExtraBytes: 0,
        providerExtraByWire: new Map(),
        blockKinds: new Map(),
        closedBlocks: new Set(),
      };
      let reason: "stop" | "length" | "toolUse" = "stop";
      let sawMessageStop = false;
      let terminal = false;
      for await (const event of response.stream) {
        signal.throwIfAborted();
        if (event.metadata !== undefined) {
          if (!sawMessageStop) throw new TypeError("Bedrock metadata arrived before messageStop");
          applyBedrockUsage(message, event.metadata.usage);
          terminal = true;
          break;
        }
        if (sawMessageStop) throw new TypeError("Bedrock emitted content after messageStop");
        processBedrockEvent(
          event,
          message,
          stream,
          tools,
          texts,
          thinking,
          providerBlocks,
          budget,
          showReasoningSummary,
          snapshot,
          (next) => {
            reason = next;
            sawMessageStop = true;
          },
        );
      }
      if (!sawMessageStop) throw new TypeError("Bedrock ConverseStream ended before messageStop");
      if (!terminal) throw new TypeError("Bedrock ConverseStream ended before metadata");
      for (const wireIndex of [...budget.blockKinds.keys()]
        .filter((wireIndex) => !budget.closedBlocks.has(wireIndex))
        .sort((left, right) => left - right)) {
        finishBedrockBlock(wireIndex, message, stream, tools, texts, thinking, providerBlocks, budget, snapshot);
      }
      if (providerBlocks.size > 0) {
        message.providerState = {
          source: { api: model.api, provider: model.provider, model: model.id },
          value: [...providerBlocks.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, block]) => structuredClone(block)),
        };
      }
      message.stopReason = reason;
      const cost = calculateCost(model, message.usage);
      if (cost !== undefined) message.usage.cost = cost;
      stream.push({ type: "done", reason, message: snapshot() });
    })().catch((cause) => {
      message.stopReason = signal.aborted ? "aborted" : "error";
      if (!signal.aborted) message.errorMessage = errorMessage(cause);
      stream.push({ type: "error", reason: signal.aborted ? "aborted" : "error", error: snapshot() });
    });
    return stream;
  };
}

function processBedrockEvent(
  event: ConverseStreamOutput,
  message: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  tools: Map<number, BedrockToolState>,
  texts: Map<number, number>,
  thinking: Map<number, number>,
  providerBlocks: Map<number, BedrockContentBlock>,
  budget: BedrockContentBudget,
  showReasoningSummary: boolean,
  snapshot: () => AssistantMessage,
  setReason: (reason: "stop" | "length" | "toolUse") => void,
): void {
  if (event.contentBlockStart?.start?.toolUse) {
    const block = event.contentBlockStart.start.toolUse;
    const wireIndex = bedrockWireIndex(event.contentBlockStart.contentBlockIndex, message.content.length);
    const contentIndex = message.content.length;
    enterBedrockBlock(budget, wireIndex, "tool");
    if (tools.has(wireIndex)) throw new TypeError("Bedrock emitted a duplicate tool-call start");
    if (contentIndex >= MAX_ASSISTANT_BLOCKS) {
      throw new RangeError(`Assistant content exceeded ${MAX_ASSISTANT_BLOCKS} blocks`);
    }
    const id = requiredToolIdentity(
      block.toolUseId ?? `bedrock_${contentIndex}`,
      "tool-call ID",
      MAX_TOOL_CALL_ID_BYTES,
    );
    const name = requiredToolIdentity(block.name ?? "tool", "tool-call name", MAX_TOOL_CALL_NAME_BYTES);
    if (EMPTY_TOOL_ARGUMENT_BYTES > MAX_ASSISTANT_CONTENT_BYTES - budget.contentBytes - budget.providerExtraBytes) {
      throw new RangeError("Assistant content exceeded 8 MiB");
    }
    budget.contentBytes += EMPTY_TOOL_ARGUMENT_BYTES;
    message.content.push({ type: "toolCall", id, name, arguments: {} });
    tools.set(wireIndex, { contentIndex, raw: "", rawBytes: 0 });
    setProviderBlock(providerBlocks, wireIndex, { toolUse: { toolUseId: id, name, input: {} } });
    stream.push({ type: "toolcall_start", contentIndex, id, name, partial: snapshot() });
  }
  const delta = event.contentBlockDelta?.delta;
  if (delta?.text) {
    const wireIndex = bedrockWireIndex(event.contentBlockDelta?.contentBlockIndex, 0);
    enterBedrockBlock(budget, wireIndex, "text");
    let contentIndex = texts.get(wireIndex);
    let block = contentIndex === undefined ? undefined : message.content[contentIndex];
    const deltaBytes = byteLength(delta.text);
    const fieldBytes = contentIndex === undefined ? 0 : budget.fieldBytes.get(contentIndex) ?? 0;
    if (deltaBytes > MAX_ASSISTANT_FIELD_BYTES - fieldBytes) {
      throw new RangeError("Assistant text content exceeded 4 MiB");
    }
    if (deltaBytes > MAX_ASSISTANT_CONTENT_BYTES - budget.contentBytes - budget.providerExtraBytes) {
      throw new RangeError("Assistant content exceeded 8 MiB");
    }
    if (contentIndex === undefined || block?.type !== "text") {
      if (message.content.length >= MAX_ASSISTANT_BLOCKS) {
        throw new RangeError(`Assistant content exceeded ${MAX_ASSISTANT_BLOCKS} blocks`);
      }
      contentIndex = message.content.length;
      block = { type: "text", text: "" };
      message.content.push(block);
      texts.set(wireIndex, contentIndex);
      stream.push({ type: "text_start", contentIndex, partial: snapshot() });
    }
    const providerBlock = providerBlocks.get(wireIndex);
    setProviderBlock(providerBlocks, wireIndex, {
      text: `${providerBlock !== undefined && "text" in providerBlock ? providerBlock.text ?? "" : ""}${delta.text}`,
    });
    block.text += delta.text;
    budget.fieldBytes.set(contentIndex, fieldBytes + deltaBytes);
    budget.contentBytes += deltaBytes;
    stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: snapshot() });
  }
  if (delta?.toolUse?.input) {
    const wireIndex = bedrockWireIndex(event.contentBlockDelta?.contentBlockIndex, -1);
    const tool = tools.get(wireIndex);
    if (tool === undefined) throw new TypeError("Bedrock tool arguments require an active tool call");
    {
      const deltaBytes = byteLength(delta.toolUse.input);
      if (deltaBytes > MAX_ASSISTANT_FIELD_BYTES - tool.rawBytes) {
        throw new RangeError("Tool arguments exceeded 4 MiB");
      }
      const retainedBytes = budget.contentBytes - Math.max(tool.rawBytes, EMPTY_TOOL_ARGUMENT_BYTES);
      const nextArgumentBytes = tool.rawBytes + deltaBytes;
      const nextContentBytes = retainedBytes + Math.max(nextArgumentBytes, EMPTY_TOOL_ARGUMENT_BYTES);
      if (nextContentBytes > MAX_ASSISTANT_CONTENT_BYTES - budget.providerExtraBytes) {
        throw new RangeError("Assistant content exceeded 8 MiB");
      }
      tool.raw += delta.toolUse.input;
      tool.rawBytes = nextArgumentBytes;
      budget.contentBytes = nextContentBytes;
      stream.push({ type: "toolcall_delta", contentIndex: tool.contentIndex, delta: delta.toolUse.input, partial: snapshot() });
    }
  }
  if (delta?.reasoningContent) {
    const wireIndex = bedrockWireIndex(event.contentBlockDelta?.contentBlockIndex, 0);
    enterBedrockBlock(budget, wireIndex, "thinking");
    const text = delta.reasoningContent.text;
    const signature = delta.reasoningContent.signature;
    const redactedContent = delta.reasoningContent.redactedContent;
    let contentIndex = thinking.get(wireIndex);
    const existingThinking = contentIndex === undefined ? undefined : message.content[contentIndex];
    const textBytes = showReasoningSummary && text ? byteLength(text) : 0;
    const fieldBytes = contentIndex === undefined ? 0 : budget.fieldBytes.get(contentIndex) ?? 0;
    if (textBytes > MAX_ASSISTANT_FIELD_BYTES - fieldBytes) {
      throw new RangeError("Assistant thinking content exceeded 4 MiB");
    }
    if (textBytes > MAX_ASSISTANT_CONTENT_BYTES - budget.contentBytes - budget.providerExtraBytes) {
      throw new RangeError("Assistant content exceeded 8 MiB");
    }
    if (showReasoningSummary && text && existingThinking?.type !== "thinking" && message.content.length >= MAX_ASSISTANT_BLOCKS) {
      throw new RangeError(`Assistant content exceeded ${MAX_ASSISTANT_BLOCKS} blocks`);
    }
    if (showReasoningSummary && signature && byteLength(signature) > MAX_ASSISTANT_FIELD_BYTES) {
      throw new RangeError("Assistant thinking signature exceeded 4 MiB");
    }
    if (redactedContent !== undefined && redactedContent.byteLength > MAX_ASSISTANT_FIELD_BYTES) {
      throw new RangeError("Bedrock redacted reasoning content exceeded 4 MiB");
    }
    const current = providerBlocks.get(wireIndex);
    const currentReasoning = current !== undefined && "reasoningContent" in current
      ? current.reasoningContent
      : undefined;
    const currentText = currentReasoning?.reasoningText;
    const currentRedacted = currentReasoning?.redactedContent;
    if (redactedContent !== undefined || currentRedacted !== undefined) {
      const nextRedacted = redactedContent === undefined
        ? new Uint8Array(currentRedacted!)
        : new Uint8Array(redactedContent);
      setProviderExtraBytes(budget, wireIndex, nextRedacted.byteLength);
      setProviderBlock(providerBlocks, wireIndex, {
        reasoningContent: {
          redactedContent: nextRedacted,
        },
      });
    } else if (showReasoningSummary && (text !== undefined || signature !== undefined)) {
      const nextText = `${currentText?.text ?? ""}${text ?? ""}`;
      const nextSignature = signature ?? currentText?.signature;
      const extraBytes = byteLength(nextText) + (nextSignature === undefined ? 0 : byteLength(nextSignature));
      setProviderExtraBytes(budget, wireIndex, Math.max(0, extraBytes - (showReasoningSummary ? byteLength(nextText) : 0)));
      setProviderBlock(providerBlocks, wireIndex, {
        reasoningContent: {
          reasoningText: {
            text: nextText,
            ...(signature === undefined && currentText?.signature === undefined
              ? {}
              : { signature: signature ?? currentText?.signature }),
          },
        },
      });
    }
    if (showReasoningSummary && text) {
      if (contentIndex === undefined) {
        contentIndex = message.content.length;
        thinking.set(wireIndex, contentIndex);
        message.content.push({ type: "thinking", thinking: "" });
        stream.push({ type: "thinking_start", contentIndex, partial: snapshot() });
      }
      const block = message.content[contentIndex];
      if (block?.type === "thinking") {
        block.thinking += text;
        budget.fieldBytes.set(contentIndex, fieldBytes + textBytes);
        budget.contentBytes += textBytes;
        stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: snapshot() });
      }
    }
    if (showReasoningSummary && signature) {
      const contentIndex = thinking.get(wireIndex);
      const block = contentIndex === undefined ? undefined : message.content[contentIndex];
      if (block?.type === "thinking") block.thinkingSignature = signature;
    }
  }
  if (event.contentBlockStop) {
    const wireIndex = bedrockWireIndex(event.contentBlockStop.contentBlockIndex, -1);
    finishBedrockBlock(wireIndex, message, stream, tools, texts, thinking, providerBlocks, budget, snapshot);
  }
  const reason = event.messageStop?.stopReason;
  if (reason === "max_tokens") setReason("length");
  else if (reason === "tool_use") setReason("toolUse");
  else if (event.messageStop !== undefined) setReason("stop");
}

function applyBedrockUsage(message: AssistantMessage, value: TokenUsage | undefined): void {
  if (value) {
    const usage = value;
    const nativeInput = tokenCount(usage.inputTokens);
    const output = tokenCount(usage.outputTokens);
    const cacheRead = tokenCount(usage.cacheReadInputTokens);
    const cacheWrite = tokenCount(usage.cacheWriteInputTokens);
    const reportedTotal = tokenCount(usage.totalTokens);
    let input = nativeInput;
    if (reportedTotal !== undefined && output !== undefined) {
      const knownNonInput = tokenSum(output, cacheRead ?? 0, cacheWrite ?? 0);
      const reconciled = knownNonInput === undefined ? -1 : reportedTotal - knownNonInput;
      if (reconciled >= 0 && (input === undefined || reconciled >= input)) input = reconciled;
    }
    if (input !== undefined) message.usage.input = input;
    if (output !== undefined) message.usage.output = output;
    if (cacheRead !== undefined) message.usage.cacheRead = cacheRead;
    if (cacheWrite !== undefined) message.usage.cacheWrite = cacheWrite;
    const knownComponents = [input, output, cacheRead, cacheWrite]
      .filter((candidate): candidate is number => candidate !== undefined);
    const knownTotal = tokenSum(...knownComponents);
    const completeComponents = input !== undefined && output !== undefined
      && cacheRead !== undefined && cacheWrite !== undefined;
    if (
      reportedTotal !== undefined && knownTotal !== undefined && reportedTotal >= knownTotal
      && (!completeComponents || reportedTotal === knownTotal)
    ) {
      message.usage.totalTokens = reportedTotal;
    } else if (
      input !== undefined && output !== undefined && cacheRead !== undefined && cacheWrite !== undefined
    ) {
      const total = tokenSum(
        input,
        output,
        cacheRead,
        cacheWrite,
      );
      if (total !== undefined) message.usage.totalTokens = total;
    }
  }
}

function finishBedrockBlock(
  wireIndex: number,
  message: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  tools: Map<number, BedrockToolState>,
  texts: Map<number, number>,
  thinking: Map<number, number>,
  providerBlocks: Map<number, BedrockContentBlock>,
  budget: BedrockContentBudget,
  snapshot: () => AssistantMessage,
): void {
  if (!budget.blockKinds.has(wireIndex)) throw new TypeError("Bedrock stopped an unknown content block");
  if (budget.closedBlocks.has(wireIndex)) throw new TypeError("Bedrock stopped a content block twice");
  const tool = tools.get(wireIndex);
  if (tool !== undefined) {
    const block = message.content[tool.contentIndex];
    if (block?.type !== "toolCall") throw new TypeError("Bedrock tool call state is invalid");
    const finalized = canonicalToolArguments(tool.raw);
    const retainedBytes = budget.contentBytes - Math.max(tool.rawBytes, EMPTY_TOOL_ARGUMENT_BYTES);
    if (finalized.bytes > MAX_ASSISTANT_CONTENT_BYTES - retainedBytes - budget.providerExtraBytes) {
      throw new RangeError("Assistant content exceeded 8 MiB");
    }
    budget.contentBytes = retainedBytes + finalized.bytes;
    block.arguments = finalized.value;
    setProviderBlock(providerBlocks, wireIndex, {
      toolUse: { toolUseId: block.id, name: block.name, input: structuredClone(block.arguments) as never },
    });
    stream.push({
      type: "toolcall_end",
      contentIndex: tool.contentIndex,
      toolCall: structuredClone(block),
      partial: snapshot(),
    });
    tools.delete(wireIndex);
  }

  const textIndex = texts.get(wireIndex);
  const textBlock = textIndex === undefined ? undefined : message.content[textIndex];
  if (textIndex !== undefined && textBlock?.type === "text") {
    stream.push({
      type: "text_end",
      contentIndex: textIndex,
      content: textBlock.text,
      partial: snapshot(),
    });
    texts.delete(wireIndex);
  }

  const thinkingIndex = thinking.get(wireIndex);
  const thinkingBlock = thinkingIndex === undefined ? undefined : message.content[thinkingIndex];
  if (thinkingIndex !== undefined && thinkingBlock?.type === "thinking") {
    stream.push({
      type: "thinking_end",
      contentIndex: thinkingIndex,
      content: thinkingBlock.thinking,
      ...(thinkingBlock.thinkingSignature === undefined ? {} : { contentSignature: thinkingBlock.thinkingSignature }),
      partial: snapshot(),
    });
    thinking.delete(wireIndex);
  }
  budget.closedBlocks.add(wireIndex);
}

function bedrockAssistantContent(
  message: AssistantMessage,
  model: Model<"bedrock-converse-stream">,
): BedrockContentBlock[] {
  const state = message.providerState;
  const sameModel = message.api === model.api && message.provider === model.provider && message.model === model.id;
  if (
    sameModel &&
    state?.source.api === message.api &&
    state.source.provider === message.provider &&
    state.source.model === message.model &&
    state.source.api === model.api &&
    state.source.provider === model.provider &&
    state.source.model === model.id
  ) {
    try {
      if (Array.isArray(state.value)) return structuredClone(state.value) as BedrockContentBlock[];
    } catch {}
  }
  return message.content.flatMap((part): BedrockContentBlock[] => {
    if (part.type === "text") return [{ text: part.text }];
    if (part.type === "toolCall") {
      return [{ toolUse: { toolUseId: part.id, name: part.name, input: structuredClone(part.arguments) as never } }];
    }
    if (!sameModel) return part.redacted !== true && part.thinking.trim() !== "" ? [{ text: part.thinking }] : [];
    if (part.redacted === true || part.thinkingSignature === undefined) return [];
    return [{
      reasoningContent: {
        reasoningText: {
          text: part.thinking,
          signature: part.thinkingSignature,
        },
      },
    }];
  });
}

const BEDROCK_MANUAL_THINKING_BUDGETS: Readonly<Record<"minimal" | "low" | "medium" | "high", number>> =
  Object.freeze({ minimal: 1_024, low: 2_048, medium: 8_192, high: 16_384 });

function bedrockThinkingFields(
  model: Model<"bedrock-converse-stream">,
  options: SimpleStreamOptions,
  region: string | undefined,
): Record<string, unknown> | undefined {
  const requested = options.reasoning;
  if (!model.reasoning || requested === undefined || requested === "off" || !isAnthropicBedrockModel(model)) {
    return undefined;
  }
  const mapped = Object.hasOwn(model.thinkingLevelMap ?? {}, requested)
    ? model.thinkingLevelMap?.[requested]
    : requested;
  if (typeof mapped === "string" && mapped.toLocaleLowerCase("en-US") === "ultra") {
    throw new RangeError("Reasoning effort ultra is not supported");
  }
  if (mapped === null || mapped === undefined || mapped === "off" || mapped === "none" || mapped === "disabled") {
    return undefined;
  }
  const display = model.compat?.supportsThinkingDisplay === false || isGovCloudBedrockModel(model.id, region)
    ? {}
    : { display: "summarized" as const };
  if (model.compat?.forceAdaptiveThinking === true || supportsAdaptiveBedrockThinking(model)) {
    return {
      thinking: { type: "adaptive", ...display },
      output_config: { effort: bedrockAdaptiveEffort(mapped) },
    };
  }
  const level: "minimal" | "low" | "medium" | "high" =
    mapped === "minimal" || mapped === "low" || mapped === "medium" || mapped === "high"
      ? mapped
      : "high";
  const configured = options.thinkingBudgets?.[requested as Exclude<ThinkingLevel, "off">]
    ?? options.thinkingBudgets?.[level]
    ?? BEDROCK_MANUAL_THINKING_BUDGETS[level];
  const maxTokens = options.maxTokens ?? model.maxTokens;
  if (maxTokens <= 1_024) {
    throw new RangeError("Bedrock maxTokens must exceed the 1,024-token minimum thinking budget");
  }
  const budgetTokens = Math.min(configured, Math.max(1_024, maxTokens - 1_024));
  return {
    thinking: { type: "enabled", budget_tokens: budgetTokens, ...display },
    anthropic_beta: ["interleaved-thinking-2025-05-14"],
  };
}

function bedrockAdaptiveEffort(effort: string): string {
  if (effort === "minimal") return "low";
  return effort;
}

function bedrockModelCandidates(model: Model<"bedrock-converse-stream">): string[] {
  return [model.id, model.name].map((value) => value.toLowerCase().replace(/[\s_.:]+/gu, "-"));
}

function isAnthropicBedrockModel(model: Model<"bedrock-converse-stream">): boolean {
  return bedrockModelCandidates(model).some((value) => value.includes("anthropic") || value.includes("claude"));
}

function supportsAdaptiveBedrockThinking(model: Model<"bedrock-converse-stream">): boolean {
  const candidates = bedrockModelCandidates(model);
  return ["mythos-5", "fable-5", "mythos-preview", "opus-4-6", "opus-4-7", "opus-4-8", "opus-5", "sonnet-4-6", "sonnet-5"]
    .some((fragment) => candidates.some((value) => value.includes(fragment)));
}

function isGovCloudBedrockModel(model: string, region: string | undefined): boolean {
  const normalized = model.toLowerCase();
  return region?.toLowerCase().startsWith("us-gov-") === true
    || normalized.startsWith("us-gov.")
    || normalized.startsWith("arn:aws-us-gov:");
}

export function bedrockProvider(models: readonly Model<"bedrock-converse-stream">[], options: BedrockTransportOptions = {}): Provider<"bedrock-converse-stream"> {
  const transport = createBedrockConverseTransport(options);
  return {
    id: "bedrock",
    name: "Amazon Bedrock",
    auth: {},
    getModels: () => models,
    stream: transport,
    streamSimple: transport,
  };
}
