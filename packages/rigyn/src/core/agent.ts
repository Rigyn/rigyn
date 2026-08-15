import {
  RuntimeEngine as KernelRuntimeEngine,
  RunControl,
  type AgentLifecycleObserver,
  type AgentRunRequest as KernelAgentRunRequest,
  type AgentRunResult,
} from "@rigyn/kernel/runtime/core/agent";
import type {
  ToolExecutionObserver,
  ToolExecutionPort,
} from "@rigyn/kernel/runtime/tools/execution";

import type { ToolCoordinator, ToolCoordinatorObserver } from "../tools/coordinator.js";
import type { ToolContext } from "../tools/types.js";
import type { EventSink } from "./events.js";
import type { RunId, ThreadId } from "./ids.js";
import type { ConversationPort } from "./ports.js";
import type { RetryPolicy } from "./retry.js";

export {
  RunControl,
  assertQueuedRunMessages,
  attachQueuedRunDelivery,
  cloneQueuedRunMessage,
  queuedMessageSizes,
  queuedRunDeliveryId,
  queuedRunDeliveryMessageId,
} from "@rigyn/kernel/runtime/core/agent";
export type {
  AgentCompactionDirective,
  AgentExtensionReducers,
  AgentExtensionRunScope,
  AgentFinalizedAssistantReduction,
  AgentFinalizedAssistantResponse,
  AgentLifecycleObserver,
  AgentRunResult,
  AgentTurnSelection,
  AgentTurnSelectionContext,
  QueueMode,
  QueuedRunDeliveryReceipt,
  QueuedRunMessage,
} from "@rigyn/kernel/runtime/core/agent";

export interface AgentRunRequest extends Omit<KernelAgentRunRequest, "operationId" | "tools"> {
  /** Stable caller-supplied identity for this operation. A generated run id is used when omitted. */
  operationId?: string;
  tools: ToolCoordinator;
  toolContext: Omit<ToolContext, "eventSink" | "signal" | "runId" | "threadId">;
}

function executionObserver(observer: ToolExecutionObserver): ToolCoordinatorObserver {
  return {
    ...(observer.transformed === undefined ? {} : { transformed: observer.transformed }),
    ...(observer.started === undefined ? {} : { started: observer.started }),
    ...(observer.dispatching === undefined ? {} : { dispatching: observer.dispatching }),
    ...(observer.progress === undefined ? {} : { progress: observer.progress }),
    ...(observer.completed === undefined ? {} : { completed: observer.completed }),
  };
}

function executionPort(request: AgentRunRequest): ToolExecutionPort {
  return {
    turnSnapshot: () => request.tools.turnSnapshot(),
    execute: (invocations, context, observer, options) => request.tools.execute(
      invocations,
      { ...request.toolContext, ...context },
      executionObserver(observer),
      options,
    ),
  };
}

function kernelRequest(request: AgentRunRequest): KernelAgentRunRequest {
  return {
    ...request,
    tools: executionPort(request),
  };
}

export class AgentRunner {
  readonly #runner: KernelRuntimeEngine;

  constructor(options: {
    conversation: ConversationPort;
    events: (threadId: ThreadId, runId: RunId, branch: string | undefined, signal: AbortSignal) => EventSink;
    retry?: RetryPolicy;
    random?: () => number;
    lifecycle?: AgentLifecycleObserver;
  }) {
    this.#runner = new KernelRuntimeEngine(options);
  }

  run(
    request: AgentRunRequest,
    control?: RunControl,
    continuation = false,
  ): Promise<AgentRunResult> {
    return this.#runner.run(kernelRequest(request), control, continuation);
  }
}
