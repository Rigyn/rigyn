import type { RunState } from "../core/events.js";

export interface FooterActivitySnapshot {
  phase: string;
  startedAt: number;
  retryAt?: number;
  attempt?: number;
  cancellable?: boolean;
}

export interface FooterWorkingIndicatorSnapshot {
  frames: readonly string[];
  intervalMs: number;
  hidden?: boolean;
}

/** Safe live values used by the built-in footer. */
export interface FooterDataSnapshot {
  workspace?: string;
  sessionName?: string;
  releaseVersion?: string;
  active?: boolean;
  status?: RunState | "idle" | "working";
  activity?: Readonly<FooterActivitySnapshot>;
  activityFrame?: number;
  workingMessage?: string;
  workingVisible?: boolean;
  workingIndicator?: Readonly<FooterWorkingIndicatorSnapshot>;
  provider?: string;
  model?: string;
  thinking?: string;
  thinkingSupported?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Exact aggregate prompt/context input, including cache reads and writes. */
  promptInputTokens?: number;
  /** Reported aggregate prompt/context lower bound. */
  promptInputTokensReported?: number;
  inputTokensReported?: number;
  outputTokensReported?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  /** Newest provider report when the corresponding transcript aggregate is unavailable. */
  latestCacheReadTokens?: number;
  latestCacheWriteTokens?: number;
  latestCacheWrite1hTokens?: number;
  /** Latest non-summary request reuse percentage; token counters above are transcript aggregates. */
  cacheHitRate?: number;
  cost?: number;
  contextTokens?: number;
  contextWindowTokens?: number;
  contextSource?: "provider" | "estimated";
  autoCompaction?: boolean;
  autoCompactionThresholdPercent?: number;
  subscription?: boolean;
}

/** Read-only live data supplied to trusted raw footer factories. */
export interface ReadonlyFooterDataProvider {
  getSnapshot(): Readonly<FooterDataSnapshot>;
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
}
