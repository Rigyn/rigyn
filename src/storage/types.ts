import type { RunState, RuntimeEvent } from "../core/events.js";
import type { ArtifactId, EventId, RunId, ThreadId } from "../core/ids.js";
import type { ImageBlock, ProviderId } from "../core/types.js";

export interface ThreadRecord {
  threadId: ThreadId;
  name?: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  parentThreadId?: ThreadId;
  parentRunId?: RunId;
  workspaceRoot?: string;
  branches: BranchRecord[];
}

export interface ThreadMetadataRecord {
  threadId: ThreadId;
  name?: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMetadataCursor {
  updatedAt: string;
  threadId: ThreadId;
}

export interface ThreadMetadataPage {
  threads: ThreadMetadataRecord[];
  next?: ThreadMetadataCursor;
  hasMore: boolean;
}

export interface ThreadPreviewOptions {
  branch?: string;
  messageCountLimit?: number;
  recentMessageLimit?: number;
  searchByteLimit?: number;
}

export interface ThreadPreview {
  branch: string;
  hasUserMessage: boolean;
  firstPrompt?: string;
  recentSearchText: string;
  searchTruncated: boolean;
  messageCount: number;
  messageCountTruncated: boolean;
  latestProvider?: ProviderId;
  latestModel?: string;
}

export interface BranchRecord {
  threadId: ThreadId;
  name: string;
  headEventId?: EventId;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  runId: RunId;
  threadId: ThreadId;
  branch: string;
  state: RunState;
  provider?: ProviderId;
  model?: string;
  startedAt: string;
  endedAt?: string;
}

export interface ArtifactRecord {
  artifactId: ArtifactId;
  threadId: ThreadId;
  runId?: RunId;
  eventId?: EventId;
  mediaType: string;
  byteLength: number;
  sha256: string;
  content: Uint8Array;
  createdAt: string;
}

export interface AppendEventInput<T extends RuntimeEvent = RuntimeEvent> {
  threadId: ThreadId;
  branch?: string;
  runId?: RunId;
  event: T;
  eventId?: EventId;
  timestamp?: string;
  expectedHead?: EventId | null;
}

export interface RecoveryReport {
  recoveredRunIds: RunId[];
  repairedToolCallIds: string[];
  inDoubtToolCallIds: string[];
  reconstructedToolCallIds: string[];
}

export interface EntryLabelRecord {
  targetEventId: EventId;
  label: string;
  changedAt: string;
  changeEventId: EventId;
}

export type RunInputQueueState = "queued" | "draining" | "recoverable" | "leased" | "quarantined";

export interface RunInputQueueRecord {
  queueId: string;
  sequence: number;
  messageId: string;
  threadId: ThreadId;
  branch: string;
  mode: "steer" | "follow_up";
  state: RunInputQueueState;
  text: string;
  images?: ImageBlock[];
  createdAt: string;
}

export interface EnqueueRunInput {
  threadId: ThreadId;
  branch: string;
  mode: "steer" | "follow_up";
  text: string;
  images?: ImageBlock[];
}

export interface RunInputRecoveryReport {
  recovered: number;
  reconciled: number;
  quarantined: number;
}

export interface StorageOptions {
  busyTimeoutMs?: number;
  maxArtifactBytes?: number;
  maxArtifactStoreBytes?: number;
  clock?: () => Date;
  idFactory?: (prefix: string) => string;
}
