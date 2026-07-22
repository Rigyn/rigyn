import { EventStream, type AssistantMessage, type Context, type Message, type ToolResultMessage, validateToolArguments } from "@rigyn/models";
import { getDefaultStreamFn } from "./stream-fn.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

function eventStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream(
    (event) => event.type === "agent_end",
    (event) => event.type === "agent_end" ? event.messages : [],
  );
}

export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  streamFunction: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = eventStream();
  void runAgentLoop(prompts, context, config, (event) => stream.push(event), signal, streamFunction)
    .then((messages) => stream.end(messages), (error) => stream.fail(error));
  return stream;
}

export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  streamFunction: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  assertContinuable(context);
  const stream = eventStream();
  void runAgentLoopContinue(context, config, (event) => stream.push(event), signal, streamFunction)
    .then((messages) => stream.end(messages), (error) => stream.fail(error));
  return stream;
}

function assertContinuable(context: AgentContext): void {
  if (context.messages.length === 0) throw new Error("Cannot continue: no messages in context");
  if (context.messages.at(-1)?.role === "assistant") throw new Error("Cannot continue from message role: assistant");
}

export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFunction: StreamFn,
): Promise<AgentMessage[]> {
  const produced = [...prompts];
  const live: AgentContext = { ...context, messages: [...context.messages, ...prompts], ...(context.tools ? { tools: context.tools.slice() } : {}) };
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }
  await runTurns(live, produced, config, emit, signal, streamFunction ?? getDefaultStreamFn());
  return produced;
}

export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFunction: StreamFn,
): Promise<AgentMessage[]> {
  assertContinuable(context);
  const produced: AgentMessage[] = [];
  const live: AgentContext = { ...context, messages: [...context.messages], ...(context.tools ? { tools: context.tools.slice() } : {}) };
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await runTurns(live, produced, config, emit, signal, streamFunction ?? getDefaultStreamFn());
  return produced;
}

async function runTurns(
  initialContext: AgentContext,
  produced: AgentMessage[],
  initialConfig: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFunction: StreamFn,
): Promise<void> {
  let context = initialContext;
  let config = initialConfig;
  let first = true;
  let pending = await config.getSteeringMessages?.() ?? [];

  for (;;) {
    let continueForTools = true;
    while (continueForTools || pending.length > 0) {
      if (first) first = false;
      else await emit({ type: "turn_start" });

      for (const queued of pending) {
        await emit({ type: "message_start", message: queued });
        await emit({ type: "message_end", message: queued });
        context.messages.push(queued);
        produced.push(queued);
      }
      pending = [];

      const assistant = await streamAssistant(context, config, emit, signal, streamFunction);
      produced.push(assistant);
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        await emit({ type: "turn_end", message: assistant, toolResults: [] });
        await emit({ type: "agent_end", messages: produced });
        return;
      }

      const calls = assistant.content.filter((part): part is AgentToolCall => part.type === "toolCall");
      let results: ToolResultMessage[] = [];
      continueForTools = false;
      if (calls.length > 0) {
        const batch = assistant.stopReason === "length"
          ? await rejectTruncatedCalls(calls, emit)
          : await executeCalls(context, assistant, calls, config, emit, signal);
        results = batch.messages;
        continueForTools = !batch.terminate;
        for (const result of results) {
          context.messages.push(result);
          produced.push(result);
        }
      }

      await emit({ type: "turn_end", message: assistant, toolResults: results });
      const turn = { message: assistant, toolResults: results, context, newMessages: produced };
      const update = await config.prepareNextTurn?.(turn);
      if (update) {
        context = update.context ?? context;
        config = {
          ...config,
          model: update.model ?? config.model,
        };
        if (update.thinkingLevel !== undefined) {
          if (update.thinkingLevel === "off") delete config.reasoning;
          else config.reasoning = update.thinkingLevel;
        }
      }
      if (await config.shouldStopAfterTurn?.({ message: assistant, toolResults: results, context, newMessages: produced })) {
        await emit({ type: "agent_end", messages: produced });
        return;
      }
      pending = await config.getSteeringMessages?.() ?? [];
    }

    const followUps = await config.getFollowUpMessages?.() ?? [];
    if (followUps.length === 0) break;
    pending = followUps;
  }
  await emit({ type: "agent_end", messages: produced });
}

async function streamAssistant(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFunction: StreamFn,
): Promise<AssistantMessage> {
  const transformed = config.transformContext ? await config.transformContext(context.messages, signal) : context.messages;
  const llmMessages: Message[] = await config.convertToLlm(transformed);
  const llmContext: Context = { systemPrompt: context.systemPrompt, messages: llmMessages, ...(context.tools ? { tools: context.tools } : {}) };
  const key = await config.getApiKey?.(config.model.provider) ?? config.apiKey;
  const response = await streamFunction(config.model, llmContext, { ...config, ...(key === undefined ? {} : { apiKey: key }), ...(signal === undefined ? {} : { signal }) });
  let partial: AssistantMessage | undefined;
  let inserted = false;
  for await (const event of response) {
    if (event.type === "start") {
      partial = event.partial;
      context.messages.push(partial);
      inserted = true;
      await emit({ type: "message_start", message: { ...partial } });
      continue;
    }
    if (event.type === "done" || event.type === "error") {
      const final = await response.result();
      if (inserted) context.messages[context.messages.length - 1] = final;
      else {
        context.messages.push(final);
        await emit({ type: "message_start", message: { ...final } });
      }
      await emit({ type: "message_end", message: final });
      return final;
    }
    if (partial) {
      partial = event.partial;
      context.messages[context.messages.length - 1] = partial;
      await emit({ type: "message_update", message: { ...partial }, assistantMessageEvent: event });
    }
  }
  const final = await response.result();
  if (inserted) context.messages[context.messages.length - 1] = final;
  else {
    context.messages.push(final);
    await emit({ type: "message_start", message: { ...final } });
  }
  await emit({ type: "message_end", message: final });
  return final;
}

interface Finalized {
  call: AgentToolCall;
  result: AgentToolResult;
  isError: boolean;
}

interface Batch {
  messages: ToolResultMessage[];
  terminate: boolean;
}

function errorResult(message: string): AgentToolResult {
  return { content: [{ type: "text", text: message }], details: {} };
}

async function rejectTruncatedCalls(calls: AgentToolCall[], emit: AgentEventSink): Promise<Batch> {
  const messages: ToolResultMessage[] = [];
  for (const call of calls) {
    await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    const finalized: Finalized = {
      call,
      isError: true,
      result: errorResult(`Tool call "${call.name}" was not executed because its arguments may be incomplete after the output token limit was reached.`),
    };
    await emitEnd(finalized, emit);
    const message = resultMessage(finalized);
    await emitMessage(message, emit);
    messages.push(message);
  }
  return { messages, terminate: false };
}

type Prepared = { kind: "prepared"; call: AgentToolCall; tool: AgentTool; args: unknown };
type Immediate = { kind: "immediate"; result: AgentToolResult; isError: boolean };

async function prepare(
  context: AgentContext,
  assistant: AssistantMessage,
  call: AgentToolCall,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): Promise<Prepared | Immediate> {
  const tool = context.tools?.find((candidate) => candidate.name === call.name);
  if (!tool) return { kind: "immediate", result: errorResult(`Tool ${call.name} not found`), isError: true };
  try {
    const preparedArguments = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
    const args = validateToolArguments(tool, preparedArguments === call.arguments ? call : { ...call, arguments: preparedArguments as Record<string, unknown> });
    const before = await config.beforeToolCall?.({ assistantMessage: assistant, toolCall: call, args, context }, signal);
    if (signal?.aborted) return { kind: "immediate", result: errorResult("Operation aborted"), isError: true };
    if (before?.block) return { kind: "immediate", result: errorResult(before.reason || "Tool execution was blocked"), isError: true };
    return { kind: "prepared", call, tool, args };
  } catch (error) {
    return { kind: "immediate", result: errorResult(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

async function execute(prepared: Prepared, emit: AgentEventSink, signal?: AbortSignal): Promise<{ result: AgentToolResult; isError: boolean }> {
  let open = true;
  const updates: Promise<void>[] = [];
  try {
    const result = await prepared.tool.execute(prepared.call.id, prepared.args as never, signal, (partial) => {
      if (!open) return;
      updates.push(Promise.resolve(emit({
        type: "tool_execution_update",
        toolCallId: prepared.call.id,
        toolName: prepared.call.name,
        args: prepared.call.arguments,
        partialResult: partial,
      })));
    });
    open = false;
    await Promise.all(updates);
    return { result, isError: false };
  } catch (error) {
    open = false;
    await Promise.all(updates);
    return { result: errorResult(error instanceof Error ? error.message : String(error)), isError: true };
  } finally {
    open = false;
  }
}

async function finalize(
  context: AgentContext,
  assistant: AssistantMessage,
  prepared: Prepared,
  executed: { result: AgentToolResult; isError: boolean },
  config: AgentLoopConfig,
  signal?: AbortSignal,
): Promise<Finalized> {
  let { result, isError } = executed;
  try {
    const patch = await config.afterToolCall?.({
      assistantMessage: assistant,
      toolCall: prepared.call,
      args: prepared.args,
      result,
      isError,
      context,
    }, signal);
    if (patch) {
      result = {
        ...result,
        content: patch.content ?? result.content,
        details: patch.details ?? result.details,
        ...(patch.usage === undefined ? {} : { usage: patch.usage }),
      };
      const terminate = patch.terminate ?? result.terminate;
      if (terminate === undefined) delete result.terminate;
      else result.terminate = terminate;
      isError = patch.isError ?? isError;
    }
  } catch (error) {
    result = errorResult(error instanceof Error ? error.message : String(error));
    isError = true;
  }
  return { call: prepared.call, result, isError };
}

async function runPrepared(context: AgentContext, assistant: AssistantMessage, prepared: Prepared, config: AgentLoopConfig, emit: AgentEventSink, signal?: AbortSignal): Promise<Finalized> {
  return finalize(context, assistant, prepared, await execute(prepared, emit, signal), config, signal);
}

async function executeCalls(
  context: AgentContext,
  assistant: AssistantMessage,
  calls: AgentToolCall[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<Batch> {
  const forceSequential = config.toolExecution === "sequential" || calls.some((call) => context.tools?.find((tool) => tool.name === call.name)?.executionMode === "sequential");
  return forceSequential
    ? executeSequential(context, assistant, calls, config, emit, signal)
    : executeParallel(context, assistant, calls, config, emit, signal);
}

async function executeSequential(context: AgentContext, assistant: AssistantMessage, calls: AgentToolCall[], config: AgentLoopConfig, emit: AgentEventSink, signal?: AbortSignal): Promise<Batch> {
  const finalized: Finalized[] = [];
  const messages: ToolResultMessage[] = [];
  for (const call of calls) {
    await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    const prepared = await prepare(context, assistant, call, config, signal);
    const item = prepared.kind === "immediate" ? { call, result: prepared.result, isError: prepared.isError } : await runPrepared(context, assistant, prepared, config, emit, signal);
    await emitEnd(item, emit);
    const message = resultMessage(item);
    await emitMessage(message, emit);
    finalized.push(item);
    messages.push(message);
    if (signal?.aborted) break;
  }
  return { messages, terminate: allTerminate(finalized) };
}

async function executeParallel(context: AgentContext, assistant: AssistantMessage, calls: AgentToolCall[], config: AgentLoopConfig, emit: AgentEventSink, signal?: AbortSignal): Promise<Batch> {
  const entries: Array<Finalized | Promise<Finalized>> = [];
  for (const call of calls) {
    await emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
    const prepared = await prepare(context, assistant, call, config, signal);
    if (prepared.kind === "immediate") {
      const item = { call, result: prepared.result, isError: prepared.isError };
      await emitEnd(item, emit);
      entries.push(item);
    } else {
      entries.push(runPrepared(context, assistant, prepared, config, emit, signal).then(async (item) => {
        await emitEnd(item, emit);
        return item;
      }));
    }
    if (signal?.aborted) break;
  }
  const finalized = await Promise.all(entries);
  const messages: ToolResultMessage[] = [];
  for (const item of finalized) {
    const message = resultMessage(item);
    await emitMessage(message, emit);
    messages.push(message);
  }
  return { messages, terminate: allTerminate(finalized) };
}

function allTerminate(items: Finalized[]): boolean {
  return items.length > 0 && items.every((item) => item.result.terminate === true);
}

async function emitEnd(item: Finalized, emit: AgentEventSink): Promise<void> {
  await emit({ type: "tool_execution_end", toolCallId: item.call.id, toolName: item.call.name, result: item.result, isError: item.isError });
}

function resultMessage(item: Finalized): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: item.call.id,
    toolName: item.call.name,
    content: item.result.content ?? [],
    details: item.result.details,
    ...(item.result.usage === undefined ? {} : { usage: item.result.usage }),
    ...(item.result.addedToolNames?.length ? { addedToolNames: item.result.addedToolNames } : {}),
    isError: item.isError,
    timestamp: Date.now(),
  };
}

async function emitMessage(message: ToolResultMessage, emit: AgentEventSink): Promise<void> {
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}
