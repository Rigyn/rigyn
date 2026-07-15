export interface ChildRunPolicy {
  maxConcurrent: number;
  defaultMaxSteps: number;
  maxSteps: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  defaultOutputLimitBytes: number;
  maxOutputLimitBytes: number;
}

export const ABSOLUTE_CHILD_RUN_LIMITS = Object.freeze({
  maxConcurrent: 16,
  maxSteps: 256,
  maxTimeoutMs: 3_600_000,
  maxOutputLimitBytes: 8 * 1024 * 1024,
});

export const DEFAULT_CHILD_RUN_POLICY: Readonly<ChildRunPolicy> = Object.freeze({
  maxConcurrent: 4,
  defaultMaxSteps: 32,
  maxSteps: 64,
  defaultTimeoutMs: 600_000,
  maxTimeoutMs: 600_000,
  defaultOutputLimitBytes: 64 * 1024,
  maxOutputLimitBytes: 1024 * 1024,
});

export function normalizeChildRunPolicy(
  policy: Readonly<Partial<ChildRunPolicy>> | undefined,
): ChildRunPolicy {
  const resolved: ChildRunPolicy = { ...DEFAULT_CHILD_RUN_POLICY, ...policy };
  const absoluteMaximums = {
    maxConcurrent: ABSOLUTE_CHILD_RUN_LIMITS.maxConcurrent,
    defaultMaxSteps: ABSOLUTE_CHILD_RUN_LIMITS.maxSteps,
    maxSteps: ABSOLUTE_CHILD_RUN_LIMITS.maxSteps,
    defaultTimeoutMs: ABSOLUTE_CHILD_RUN_LIMITS.maxTimeoutMs,
    maxTimeoutMs: ABSOLUTE_CHILD_RUN_LIMITS.maxTimeoutMs,
    defaultOutputLimitBytes: ABSOLUTE_CHILD_RUN_LIMITS.maxOutputLimitBytes,
    maxOutputLimitBytes: ABSOLUTE_CHILD_RUN_LIMITS.maxOutputLimitBytes,
  } as const satisfies Record<keyof ChildRunPolicy, number>;

  for (const field of Object.keys(absoluteMaximums) as (keyof ChildRunPolicy)[]) {
    const value = resolved[field];
    const maximum = absoluteMaximums[field];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`childRuns.${field} must be a safe integer from 1 through ${maximum}`);
    }
  }
  if (resolved.defaultMaxSteps > resolved.maxSteps) {
    throw new Error("childRuns.defaultMaxSteps must not exceed childRuns.maxSteps");
  }
  if (resolved.defaultTimeoutMs > resolved.maxTimeoutMs) {
    throw new Error("childRuns.defaultTimeoutMs must not exceed childRuns.maxTimeoutMs");
  }
  if (resolved.defaultOutputLimitBytes > resolved.maxOutputLimitBytes) {
    throw new Error("childRuns.defaultOutputLimitBytes must not exceed childRuns.maxOutputLimitBytes");
  }
  return resolved;
}
