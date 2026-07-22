import {
  AgentHarness,
  compact,
  generateBranchSummary,
  generateSummary,
  generateSummaryWithUsage,
  type AgentHarnessEvent,
  type AgentHarnessOptions,
  type AgentMessage,
  type CompactionPreparation,
  type ExecutionEnv,
  type Model,
  type Models,
  type Session,
} from "../src/index.js";
import type { RetryCallbacks, RetryPolicy } from "@rigyn/models";

declare const env: ExecutionEnv;
declare const session: Session;
declare const models: Models;
declare const model: Model;
declare const signal: AbortSignal;
declare const preparation: CompactionPreparation;
declare const messages: AgentMessage[];
declare const event: AgentHarnessEvent;

const retry = { enabled: true, maxRetries: 2, baseDelayMs: 100 } satisfies RetryPolicy;
const callbacks = {
  onRetryScheduled: async (_attempt: number, _maximum: number, _delay: number, _message: string) => {},
  onRetryAttemptStart: async () => {},
  onRetryFinished: async (_success: boolean, _attempt: number, _finalError?: string) => {},
} satisfies RetryCallbacks;

const options = { env, session, models, model, retry } satisfies AgentHarnessOptions;
const harness = new AgentHarness(options);
harness.on("retry_scheduled", (retryEvent) => {
  const operation: "compaction" | "branch_summary" = retryEvent.operation;
  void operation;
  return undefined;
});
void harness;

const compactResult = compact(preparation, models, model, undefined, signal, "off", retry, callbacks);
const summaryResult = generateSummary(messages, models, model, 16_384, signal, undefined, undefined, "off", retry, callbacks);
const summaryWithUsageResult = generateSummaryWithUsage(messages, models, model, 16_384, signal, undefined, undefined, "off", retry, callbacks);
const branchResult = generateBranchSummary(messages.map((message, index) => ({
  type: "message" as const,
  id: `entry-${index}`,
  parentId: index === 0 ? null : `entry-${index - 1}`,
  timestamp: new Date(0).toISOString(),
  message,
})), { models, model, signal, retry, callbacks });
void compactResult;
void summaryResult;
void summaryWithUsageResult;
void branchResult;

if (event.type === "retry_scheduled") {
  const operation: "compaction" | "branch_summary" = event.operation;
  const attempt: number = event.attempt;
  const maximum: number = event.maxAttempts;
  const delay: number = event.delayMs;
  const message: string = event.errorMessage;
  void operation;
  void attempt;
  void maximum;
  void delay;
  void message;
}
