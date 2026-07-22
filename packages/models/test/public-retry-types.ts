import {
  retryAssistantCall,
  type AssistantMessage,
  type RetryCallbacks,
  type RetryPolicy,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;

type ExpectedRetryAssistantCall = (
  produce: () => Promise<AssistantMessage>,
  policy: RetryPolicy | undefined,
  signal: AbortSignal | undefined,
  callbacks?: RetryCallbacks,
) => Promise<AssistantMessage>;

type _ExactRootExport = Assert<Equal<typeof retryAssistantCall, ExpectedRetryAssistantCall>>;

declare const produce: () => Promise<AssistantMessage>;
declare const signal: AbortSignal | undefined;
const policy = { enabled: true, maxRetries: 2, baseDelayMs: 100 } satisfies RetryPolicy;
const callbacks = {
  onRetryScheduled: async (_attempt: number, _maximum: number, _delay: number, _message: string) => {},
  onRetryAttemptStart: async () => {},
  onRetryFinished: async (_success: boolean, _attempt: number, _finalError?: string) => {},
} satisfies RetryCallbacks;
const result: Promise<AssistantMessage> = retryAssistantCall(produce, policy, signal, callbacks);
void result;
