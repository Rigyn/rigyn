import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isPromise } from "node:util/types";

import { errorMessage } from "../core/errors.js";
import { trackActiveProcessGroup } from "./active-groups.js";
import { normalizeCommandArgv } from "./command.js";
import { terminateProcessTreeAsync } from "./process-tree.js";

const DEFAULT_CAPTURE_BYTES = 256 * 1024;
const DEFAULT_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RUNNING_PER_OWNER = 4;
const DEFAULT_MAX_RUNNING = 16;
const DEFAULT_MAX_TERMINAL_PER_OWNER = 32;
const DEFAULT_MAX_TERMINAL = 128;
const DEFAULT_MAX_TERMINAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SUBSCRIPTIONS_PER_OWNER = 64;
const DEFAULT_PIPE_HIGH_WATER_BYTES = 256 * 1024;
const DEFAULT_PIPE_LOW_WATER_BYTES = 128 * 1024;
const MAX_IO_OPERATION_BYTES = 64 * 1024;
const MAX_QUEUED_INPUT_BYTES = 256 * 1024;
const MAX_QUEUED_INPUT_OPERATIONS = 64;
const MAX_ARGV_ENTRIES = 1_024;
const MAX_ARGV_BYTES = 256 * 1024;
const MAX_ENV_ENTRIES = 256;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_CWD_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const TERMINATION_ESCALATION_MS = 2_000;
const OUTPUT_DRAIN_MAX_MS = 1_000;
const DEFAULT_STATUS_UPDATE_INTERVAL_MS = 100;

export type ExtensionProcessId = string;

export type ExtensionProcessState =
  | "starting"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type ExtensionProcessOutputMode = "capture" | "pipe" | "ignore";

export interface ExtensionProcessSpec {
  argv: readonly [string, ...string[]];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  inheritEnv?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: "ignore" | "pipe";
  stdout?: ExtensionProcessOutputMode;
  stderr?: ExtensionProcessOutputMode;
  /** Retained prefix per captured stream. */
  captureLimitBytes?: number;
}

export interface ExtensionProcessStatus {
  readonly id: ExtensionProcessId;
  readonly state: ExtensionProcessState;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutRetainedBytes: number;
  readonly stderrRetainedBytes: number;
  readonly outputTruncated: boolean;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly error?: string;
}

export interface ExtensionProcessReadResult {
  readonly data: Uint8Array;
  readonly eof: boolean;
}

export interface ExtensionProcessResult extends ExtensionProcessStatus {
  readonly state: "succeeded" | "failed" | "cancelled" | "timed_out";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface ExtensionProcessWaitOptions {
  signal?: AbortSignal;
}

export interface ExtensionProcessService {
  spawn(spec: ExtensionProcessSpec): ExtensionProcessId;
  status(id: ExtensionProcessId): ExtensionProcessStatus;
  subscribe(id: ExtensionProcessId, listener: (status: ExtensionProcessStatus) => void): () => void;
  read(
    id: ExtensionProcessId,
    stream: "stdout" | "stderr",
    options?: { maxBytes?: number; signal?: AbortSignal },
  ): Promise<ExtensionProcessReadResult>;
  write(
    id: ExtensionProcessId,
    data: string | Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  closeInput(id: ExtensionProcessId, options?: { signal?: AbortSignal }): Promise<void>;
  wait(id: ExtensionProcessId, options?: ExtensionProcessWaitOptions): Promise<ExtensionProcessResult>;
  cancel(id: ExtensionProcessId): Promise<ExtensionProcessResult>;
}

export interface ManagedProcessOwner {
  readonly key: object;
  readonly signal: AbortSignal;
  isActive(): boolean;
  isCommitted(): boolean;
  diagnostic?(message: string): void;
}

export interface ManagedProcessSupervisorOptions {
  cwd: string;
  maxCaptureBytes?: number;
  maxRunningPerOwner?: number;
  maxRunning?: number;
  maxTerminalPerOwner?: number;
  maxTerminal?: number;
  maxTerminalBytes?: number;
  maxSubscriptionsPerOwner?: number;
  pipeHighWaterBytes?: number;
  pipeLowWaterBytes?: number;
  statusUpdateIntervalMs?: number;
  /** Internal deterministic test seam; runtime hosts use Node's shell-free spawn. */
  spawnProcess?: typeof spawn;
  /** Internal deterministic test seam; runtime hosts use asynchronous whole-tree termination. */
  terminateProcess?: (pid: number, signal: NodeJS.Signals) => Promise<boolean>;
}

interface PendingRead {
  maximum: number;
  resolve: (result: ExtensionProcessReadResult) => void;
  reject: (cause: unknown) => void;
  cleanups: Array<() => void>;
}

interface PipeState {
  mode: ExtensionProcessOutputMode;
  chunks: Buffer[];
  headOffset: number;
  bytes: number;
  eof: boolean;
  paused: boolean;
  pending: PendingRead | undefined;
}

interface OwnerState {
  owner: ManagedProcessOwner;
  records: Set<ProcessRecord>;
  subscriptions: number;
  abortListener: () => void;
}

type StopReason = "cancel" | "failure" | "timeout";

interface ProcessRecord {
  id: ExtensionProcessId;
  owner: OwnerState;
  state: ExtensionProcessState;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  error?: string;
  child?: ChildProcessWithoutNullStreams;
  releaseProcessGroup?: () => void;
  stopReason?: StopReason;
  stdout: PipeState;
  stderr: PipeState;
  stdoutBytes: number;
  stderrBytes: number;
  captureLimitBytes: number;
  completion: Promise<ExtensionProcessResult>;
  resolveCompletion: (result: ExtensionProcessResult) => void;
  spawnReady: Promise<void>;
  resolveSpawn: () => void;
  rejectSpawn: (cause: unknown) => void;
  listeners: Set<(status: ExtensionProcessStatus) => void>;
  notificationTimer: NodeJS.Timeout | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  escalationTimer: NodeJS.Timeout | undefined;
  drainTimer: NodeJS.Timeout | undefined;
  settlementTimer: NodeJS.Timeout | undefined;
  ownerAbort?: () => void;
  callerSignal?: AbortSignal;
  callerAbort?: () => void;
  writeTail: Promise<void>;
  queuedWriteBytes: number;
  queuedWriteOperations: number;
  inputClosing: boolean;
  closeInputOperation?: Promise<void>;
}

function positiveInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value: string, label: string, maximum: number): string {
  if (value.includes("\0") || byteLength(value) > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes or contains NUL`);
  }
  return value;
}

function outputMode(value: ExtensionProcessOutputMode | undefined, label: string): ExtensionProcessOutputMode {
  const selected = value ?? "capture";
  if (selected !== "capture" && selected !== "pipe" && selected !== "ignore") {
    throw new Error(`${label} must be capture, pipe, or ignore`);
  }
  return selected;
}

function terminal(state: ExtensionProcessState): state is ExtensionProcessResult["state"] {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "timed_out";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function withAbort<T>(operation: Promise<T>, signals: readonly (AbortSignal | undefined)[]): Promise<T> {
  const selected = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  for (const signal of selected) signal.throwIfAborted();
  if (selected.length === 0) return await operation;
  return await new Promise<T>((resolveValue, rejectValue) => {
    const listeners = new Map<AbortSignal, () => void>();
    const cleanup = (): void => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    };
    for (const signal of selected) {
      const listener = (): void => {
        cleanup();
        rejectValue(abortReason(signal));
      };
      listeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
    }
    operation.then(
      (value) => { cleanup(); resolveValue(value); },
      (cause: unknown) => { cleanup(); rejectValue(cause); },
    );
  });
}

function captureBytes(stream: PipeState): number {
  return stream.mode === "ignore" ? 0 : stream.bytes;
}

function appendCapture(stream: PipeState, chunk: Buffer, maximum: number): void {
  if (stream.bytes >= maximum) return;
  const retained = chunk.subarray(0, Math.min(chunk.length, maximum - stream.bytes));
  if (retained.length > 0) {
    stream.chunks.push(Buffer.from(retained));
    stream.bytes += retained.length;
  }
}

function pipeResult(stream: PipeState, maximum: number): ExtensionProcessReadResult {
  const selected: Buffer[] = [];
  let retained = 0;
  while (stream.chunks.length > 0 && retained < maximum) {
    const head = stream.chunks[0]!;
    const available = head.length - stream.headOffset;
    const length = Math.min(available, maximum - retained);
    selected.push(head.subarray(stream.headOffset, stream.headOffset + length));
    stream.headOffset += length;
    stream.bytes -= length;
    retained += length;
    if (stream.headOffset === head.length) {
      stream.chunks.shift();
      stream.headOffset = 0;
    }
  }
  return Object.freeze({
    data: new Uint8Array(Buffer.concat(selected, retained)),
    eof: stream.eof && stream.bytes === 0,
  });
}

function publicResult(result: ExtensionProcessResult): ExtensionProcessResult {
  return Object.freeze({
    ...result,
    stdout: new Uint8Array(result.stdout),
    stderr: new Uint8Array(result.stderr),
  });
}

/** Generation-agnostic host supervisor. Extension ownership is supplied through opaque owner keys. */
export class ManagedProcessSupervisor {
  readonly #cwd: string;
  readonly #maxCaptureBytes: number;
  readonly #maxRunningPerOwner: number;
  readonly #maxRunning: number;
  readonly #maxTerminalPerOwner: number;
  readonly #maxTerminal: number;
  readonly #maxTerminalBytes: number;
  readonly #maxSubscriptionsPerOwner: number;
  readonly #pipeHighWaterBytes: number;
  readonly #pipeLowWaterBytes: number;
  readonly #statusUpdateIntervalMs: number;
  readonly #spawnProcess: typeof spawn;
  readonly #terminateProcess: (pid: number, signal: NodeJS.Signals) => Promise<boolean>;
  readonly #owners = new Map<object, OwnerState>();
  readonly #records = new Map<ExtensionProcessId, ProcessRecord>();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: ManagedProcessSupervisorOptions) {
    this.#cwd = resolve(options.cwd);
    this.#spawnProcess = options.spawnProcess ?? spawn;
    this.#terminateProcess = options.terminateProcess ?? terminateProcessTreeAsync;
    this.#maxCaptureBytes = positiveInteger(
      options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES,
      "maxCaptureBytes",
      64 * 1024 * 1024,
    );
    this.#maxRunningPerOwner = positiveInteger(
      options.maxRunningPerOwner ?? DEFAULT_MAX_RUNNING_PER_OWNER,
      "maxRunningPerOwner",
      1_024,
    );
    this.#maxRunning = positiveInteger(options.maxRunning ?? DEFAULT_MAX_RUNNING, "maxRunning", 4_096);
    if (this.#maxRunningPerOwner > this.#maxRunning) {
      throw new RangeError("maxRunningPerOwner cannot exceed maxRunning");
    }
    this.#maxTerminalPerOwner = positiveInteger(
      options.maxTerminalPerOwner ?? DEFAULT_MAX_TERMINAL_PER_OWNER,
      "maxTerminalPerOwner",
      16_384,
    );
    this.#maxTerminal = positiveInteger(options.maxTerminal ?? DEFAULT_MAX_TERMINAL, "maxTerminal", 65_536);
    this.#maxTerminalBytes = positiveInteger(
      options.maxTerminalBytes ?? DEFAULT_MAX_TERMINAL_BYTES,
      "maxTerminalBytes",
      1024 * 1024 * 1024,
    );
    this.#maxSubscriptionsPerOwner = positiveInteger(
      options.maxSubscriptionsPerOwner ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_OWNER,
      "maxSubscriptionsPerOwner",
      16_384,
    );
    this.#pipeHighWaterBytes = positiveInteger(
      options.pipeHighWaterBytes ?? DEFAULT_PIPE_HIGH_WATER_BYTES,
      "pipeHighWaterBytes",
      64 * 1024 * 1024,
    );
    this.#pipeLowWaterBytes = positiveInteger(
      options.pipeLowWaterBytes ?? Math.min(DEFAULT_PIPE_LOW_WATER_BYTES, this.#pipeHighWaterBytes),
      "pipeLowWaterBytes",
      this.#pipeHighWaterBytes,
    );
    this.#statusUpdateIntervalMs = positiveInteger(
      options.statusUpdateIntervalMs ?? DEFAULT_STATUS_UPDATE_INTERVAL_MS,
      "statusUpdateIntervalMs",
      60_000,
    );
  }

  service(owner: ManagedProcessOwner): ExtensionProcessService {
    if (this.#closed) throw new Error("Managed process supervisor is closed");
    let state = this.#owners.get(owner.key);
    if (state === undefined) {
      state = { owner, records: new Set(), subscriptions: 0, abortListener: () => undefined };
      const selected = state;
      selected.abortListener = () => {
        for (const record of selected.records) {
          if (!terminal(record.state)) this.#stop(record, "cancel");
        }
        this.#releaseAbortedOwner(selected);
      };
      this.#owners.set(owner.key, state);
      owner.signal.addEventListener("abort", selected.abortListener, { once: true });
      if (owner.signal.aborted) selected.abortListener();
    } else if (state.owner !== owner) {
      throw new Error("Managed process owner key is already bound");
    }
    const selected = state;
    const service: ExtensionProcessService = {
      spawn: (spec) => this.#spawn(selected, spec),
      status: (id) => this.#status(this.#owned(selected, id)),
      subscribe: (id, listener) => this.#subscribe(selected, id, listener),
      read: async (id, stream, options) => await this.#read(selected, id, stream, options),
      write: async (id, data, options) => await this.#write(selected, id, data, options),
      closeInput: async (id, options) => await this.#closeInput(selected, id, options),
      wait: async (id, options) => await this.#wait(selected, id, options),
      cancel: async (id) => await this.#cancel(selected, id),
    };
    return Object.freeze(service);
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    const pending = [...this.#records.values()].filter((record) => !terminal(record.state));
    for (const record of pending) this.#stop(record, "cancel");
    this.#closing = Promise.allSettled(pending.map((record) => record.completion)).then(() => {
      for (const record of this.#records.values()) this.#disposeRecord(record);
      for (const owner of this.#owners.values()) {
        owner.owner.signal.removeEventListener("abort", owner.abortListener);
      }
      this.#records.clear();
      this.#owners.clear();
    }).finally(() => { this.#closing = undefined; });
    return this.#closing;
  }

  #assertOwner(state: OwnerState): void {
    if (this.#closed) throw new Error("Managed process supervisor is closed");
    if (!state.owner.isActive()) throw new Error("Runtime extension context is no longer active");
  }

  #owned(state: OwnerState, id: ExtensionProcessId): ProcessRecord {
    this.#assertOwner(state);
    const record = this.#records.get(id);
    if (record === undefined || record.owner !== state) throw new Error(`Unknown managed process: ${id}`);
    return record;
  }

  #runningCount(records: Iterable<ProcessRecord>): number {
    let count = 0;
    for (const record of records) if (!terminal(record.state)) count += 1;
    return count;
  }

  #validateSpec(spec: ExtensionProcessSpec): {
    argv: [string, ...string[]];
    cwd: string;
    env: Record<string, string> | undefined;
    inheritEnv: boolean;
    timeoutMs: number | undefined;
    signal: AbortSignal | undefined;
    stdin: "ignore" | "pipe";
    stdout: ExtensionProcessOutputMode;
    stderr: ExtensionProcessOutputMode;
    captureLimitBytes: number;
  } {
    if (spec === null || typeof spec !== "object") throw new TypeError("Managed process spec must be an object");
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv.length > MAX_ARGV_ENTRIES) {
      throw new Error(`Managed process argv must contain 1 through ${MAX_ARGV_ENTRIES} entries`);
    }
    let argvBytes = 0;
    for (const [index, argument] of spec.argv.entries()) {
      if (typeof argument !== "string") throw new Error(`Managed process argv[${index}] must be a string`);
      boundedText(argument, `Managed process argv[${index}]`, MAX_ARGV_BYTES);
      argvBytes += byteLength(argument);
    }
    if (argvBytes > MAX_ARGV_BYTES) throw new Error(`Managed process argv exceeds ${MAX_ARGV_BYTES} bytes`);
    const argv = normalizeCommandArgv(spec.argv);
    const cwdValue = boundedText(spec.cwd ?? this.#cwd, "Managed process cwd", MAX_CWD_BYTES);
    const cwd = resolve(this.#cwd, cwdValue);
    let env: Record<string, string> | undefined;
    if (spec.env !== undefined) {
      if (spec.env === null || typeof spec.env !== "object" || Array.isArray(spec.env)) {
        throw new TypeError("Managed process env must be a string record");
      }
      const entries = Object.entries(spec.env);
      if (entries.length > MAX_ENV_ENTRIES) throw new Error(`Managed process env exceeds ${MAX_ENV_ENTRIES} entries`);
      env = Object.create(null) as Record<string, string>;
      let envBytes = 0;
      for (const [key, value] of entries) {
        if (typeof value !== "string" || key === "" || key.includes("=") || key.includes("\0") || value.includes("\0")) {
          throw new Error("Managed process env contains an invalid key or value");
        }
        envBytes += byteLength(key) + byteLength(value);
        if (envBytes > MAX_ENV_BYTES) throw new Error(`Managed process env exceeds ${MAX_ENV_BYTES} bytes`);
        env[key] = value;
      }
    }
    const timeoutMs = spec.timeoutMs === undefined
      ? undefined
      : positiveInteger(spec.timeoutMs, "Managed process timeoutMs", MAX_TIMEOUT_MS);
    if (spec.signal !== undefined && !(spec.signal instanceof AbortSignal)) {
      throw new TypeError("Managed process signal must be an AbortSignal");
    }
    if (spec.inheritEnv !== undefined && typeof spec.inheritEnv !== "boolean") {
      throw new TypeError("Managed process inheritEnv must be a boolean");
    }
    const stdin = spec.stdin ?? "ignore";
    if (stdin !== "ignore" && stdin !== "pipe") throw new Error("Managed process stdin must be ignore or pipe");
    const captureLimitBytes = spec.captureLimitBytes ?? Math.min(DEFAULT_CAPTURE_BYTES, this.#maxCaptureBytes);
    positiveInteger(captureLimitBytes, "Managed process captureLimitBytes", this.#maxCaptureBytes);
    return {
      argv,
      cwd,
      env,
      inheritEnv: spec.inheritEnv ?? true,
      timeoutMs,
      signal: spec.signal,
      stdin,
      stdout: outputMode(spec.stdout, "Managed process stdout"),
      stderr: outputMode(spec.stderr, "Managed process stderr"),
      captureLimitBytes,
    };
  }

  #spawn(owner: OwnerState, input: ExtensionProcessSpec): ExtensionProcessId {
    this.#assertOwner(owner);
    if (!owner.owner.isCommitted()) throw new Error("Managed processes cannot start before activation commits");
    owner.owner.signal.throwIfAborted();
    const spec = this.#validateSpec(input);
    spec.signal?.throwIfAborted();
    if (this.#runningCount(owner.records) >= this.#maxRunningPerOwner || this.#runningCount(this.#records.values()) >= this.#maxRunning) {
      throw new Error("Managed process capacity is exhausted");
    }
    let resolveCompletion!: (result: ExtensionProcessResult) => void;
    const completion = new Promise<ExtensionProcessResult>((resolveValue) => { resolveCompletion = resolveValue; });
    let resolveSpawn!: () => void;
    let rejectSpawn!: (cause: unknown) => void;
    const spawnReady = new Promise<void>((resolveValue, rejectValue) => {
      resolveSpawn = resolveValue;
      rejectSpawn = rejectValue;
    });
    void spawnReady.catch(() => undefined);
    const record: ProcessRecord = {
      id: `process_${randomUUID().replaceAll("-", "")}`,
      owner,
      state: "starting",
      startedAt: Date.now(),
      stdout: { mode: spec.stdout, chunks: [], headOffset: 0, bytes: 0, eof: false, paused: false, pending: undefined },
      stderr: { mode: spec.stderr, chunks: [], headOffset: 0, bytes: 0, eof: false, paused: false, pending: undefined },
      stdoutBytes: 0,
      stderrBytes: 0,
      captureLimitBytes: spec.captureLimitBytes,
      completion,
      resolveCompletion,
      spawnReady,
      resolveSpawn,
      rejectSpawn,
      listeners: new Set(),
      notificationTimer: undefined,
      timeoutTimer: undefined,
      escalationTimer: undefined,
      drainTimer: undefined,
      settlementTimer: undefined,
      writeTail: Promise.resolve(),
      queuedWriteBytes: 0,
      queuedWriteOperations: 0,
      inputClosing: spec.stdin === "ignore",
    };
    owner.records.add(record);
    this.#records.set(record.id, record);
    const ownerAbort = (): void => this.#stop(record, "cancel");
    record.ownerAbort = ownerAbort;
    owner.owner.signal.addEventListener("abort", ownerAbort, { once: true });
    if (spec.signal !== undefined) {
      const callerAbort = (): void => this.#stop(record, "cancel");
      record.callerSignal = spec.signal;
      record.callerAbort = callerAbort;
      spec.signal.addEventListener("abort", callerAbort, { once: true });
    }
    try {
      const child = this.#spawnProcess(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.inheritEnv ? { ...process.env, ...spec.env } : { ...spec.env },
        detached: process.platform !== "win32",
        shell: false,
        stdio: "pipe",
        windowsHide: true,
      });
      record.child = child;
      record.releaseProcessGroup = trackActiveProcessGroup(child.pid);
      this.#bindChild(record, child);
      if (spec.stdin === "ignore") child.stdin.end();
      if (spec.timeoutMs !== undefined) {
        record.timeoutTimer = setTimeout(() => this.#stop(record, "timeout"), spec.timeoutMs);
        record.timeoutTimer.unref();
      }
    } catch (cause) {
      record.rejectSpawn(cause);
      this.#finish(record, "failed", null, null, cause);
    }
    return record.id;
  }

  #bindChild(record: ProcessRecord, child: ChildProcessWithoutNullStreams): void {
    let exitCleanup = Promise.resolve();
    child.once("spawn", () => {
      record.resolveSpawn();
      if (record.stopReason !== undefined) {
        this.#terminate(record, "SIGTERM");
        return;
      }
      if (record.state === "starting") {
        record.state = "running";
        this.#notify(record);
      }
    });
    child.once("error", (cause) => {
      record.rejectSpawn(cause);
      if (!terminal(record.state)) this.#finish(record, record.stopReason === "timeout" ? "timed_out" : record.stopReason === "cancel" ? "cancelled" : "failed", null, null, cause);
    });
    child.stdin.on("error", () => undefined);
    this.#bindOutput(record, "stdout", child.stdout);
    this.#bindOutput(record, "stderr", child.stderr);
    child.once("exit", (code, signal) => {
      record.exitCode = code;
      record.exitSignal = signal;
      if (child.pid !== undefined) {
        if (record.stopReason !== undefined) {
          exitCleanup = this.#terminate(record, "SIGKILL");
        } else if (process.platform === "win32") {
          exitCleanup = this.#terminate(record, "SIGKILL");
        } else {
          exitCleanup = Promise.all([
            this.#terminate(record, "SIGTERM"),
            this.#terminate(record, "SIGKILL"),
          ]).then(() => undefined);
        }
      }
      record.drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, OUTPUT_DRAIN_MAX_MS);
      record.drainTimer.unref();
    });
    child.once("close", (code, signal) => {
      void exitCleanup.then(() => {
        record.stdout.eof = true;
        record.stderr.eof = true;
        this.#flushRead(record, "stdout");
        this.#flushRead(record, "stderr");
        const state: ExtensionProcessResult["state"] = record.stopReason === "timeout"
          ? "timed_out"
          : record.stopReason === "cancel"
            ? "cancelled"
            : record.stopReason === "failure"
              ? "failed"
              : code === 0 && signal === null
                ? "succeeded"
                : "failed";
        this.#finish(record, state, code, signal);
      }).catch((cause: unknown) => {
        this.#diagnostic(record, cause, "Managed process exit cleanup failed");
        try {
          this.#finish(record, "failed", code, signal, cause);
        } catch (finishCause) {
          this.#diagnostic(record, finishCause, "Managed process terminal settlement failed");
        }
      });
    });
  }

  #bindOutput(
    record: ProcessRecord,
    name: "stdout" | "stderr",
    readable: NodeJS.ReadableStream & { pause(): unknown; resume(): unknown },
  ): void {
    const stream = record[name];
    readable.on("error", (cause) => {
      this.#stop(record, "failure", cause, `Managed process ${name} failed`);
    });
    readable.on("data", (value: Buffer | Uint8Array | string) => {
      if (terminal(record.state)) return;
      const chunk = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
      if (name === "stdout") record.stdoutBytes += chunk.length;
      else record.stderrBytes += chunk.length;
      if (stream.mode === "capture") appendCapture(stream, chunk, record.captureLimitBytes);
      else if (stream.mode === "pipe") {
        stream.chunks.push(chunk);
        stream.bytes += chunk.length;
        this.#flushRead(record, name);
        if (stream.bytes >= this.#pipeHighWaterBytes && !stream.paused) {
          stream.paused = true;
          readable.pause();
        }
      }
      this.#notify(record);
    });
    readable.once("end", () => {
      stream.eof = true;
      this.#flushRead(record, name);
    });
  }

  #status(record: ProcessRecord): ExtensionProcessStatus {
    const now = record.finishedAt ?? Date.now();
    const status: ExtensionProcessStatus = {
      id: record.id,
      state: record.state,
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      durationMs: Math.max(0, now - record.startedAt),
      stdoutBytes: record.stdoutBytes,
      stderrBytes: record.stderrBytes,
      stdoutRetainedBytes: captureBytes(record.stdout),
      stderrRetainedBytes: captureBytes(record.stderr),
      outputTruncated:
        (record.stdout.mode === "capture" && record.stdoutBytes > record.stdout.bytes)
        || (record.stderr.mode === "capture" && record.stderrBytes > record.stderr.bytes),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.exitSignal === undefined ? {} : { signal: record.exitSignal }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
    return Object.freeze(status);
  }

  #notify(record: ProcessRecord, immediate = false): void {
    if (record.listeners.size === 0 || !record.owner.owner.isActive()) return;
    const deliver = (): void => {
      record.notificationTimer = undefined;
      if (!record.owner.owner.isActive()) return;
      const status = this.#status(record);
      for (const listener of [...record.listeners]) {
        try {
          const returned = listener(status) as unknown;
          if (isPromise(returned)) {
            void returned.catch((cause: unknown) => this.#diagnostic(record, cause));
          }
        } catch (cause) {
          this.#diagnostic(record, cause);
        }
      }
    };
    if (immediate || terminal(record.state)) {
      if (record.notificationTimer !== undefined) clearTimeout(record.notificationTimer);
      deliver();
      return;
    }
    if (record.notificationTimer !== undefined) return;
    record.notificationTimer = setTimeout(deliver, this.#statusUpdateIntervalMs);
    record.notificationTimer.unref();
  }

  #diagnostic(
    record: ProcessRecord,
    cause: unknown,
    prefix = "Managed process status listener failed",
  ): void {
    const message = errorMessage(cause);
    try {
      record.owner.owner.diagnostic?.(`${prefix}: ${message.slice(0, 4_096)}`);
    } catch {
      // Diagnostics must never disrupt process ownership or cleanup.
    }
  }

  #subscribe(
    owner: OwnerState,
    id: ExtensionProcessId,
    listener: (status: ExtensionProcessStatus) => void,
  ): () => void {
    const record = this.#owned(owner, id);
    if (typeof listener !== "function") throw new TypeError("Managed process listener must be a function");
    if (owner.subscriptions >= this.#maxSubscriptionsPerOwner) throw new Error("Managed process subscription capacity is exhausted");
    const registered = (status: ExtensionProcessStatus): void => listener(status);
    record.listeners.add(registered);
    owner.subscriptions += 1;
    try {
      const returned = registered(this.#status(record)) as unknown;
      if (isPromise(returned)) void returned.catch((cause: unknown) => this.#diagnostic(record, cause));
    } catch (cause) {
      this.#diagnostic(record, cause);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (record.listeners.delete(registered)) owner.subscriptions -= 1;
    };
  }

  async #read(
    owner: OwnerState,
    id: ExtensionProcessId,
    name: "stdout" | "stderr",
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<ExtensionProcessReadResult> {
    const record = this.#owned(owner, id);
    const stream = record[name];
    if (stream.mode !== "pipe") throw new Error(`Managed process ${name} is not configured as a pipe`);
    const maximum = positiveInteger(options.maxBytes ?? MAX_IO_OPERATION_BYTES, "Managed process read maxBytes", MAX_IO_OPERATION_BYTES);
    options.signal?.throwIfAborted();
    owner.owner.signal.throwIfAborted();
    if (stream.bytes > 0 || stream.eof) {
      const result = pipeResult(stream, maximum);
      this.#resumePipe(record, name);
      return result;
    }
    if (stream.pending !== undefined) throw new Error(`Managed process ${name} already has a pending read`);
    return await new Promise<ExtensionProcessReadResult>((resolveValue, rejectValue) => {
      const pending: PendingRead = { maximum, resolve: resolveValue, reject: rejectValue, cleanups: [] };
      const listen = (signal: AbortSignal | undefined): void => {
        if (signal === undefined) return;
        const abort = (): void => {
          if (stream.pending !== pending) return;
          stream.pending = undefined;
          for (const cleanup of pending.cleanups) cleanup();
          rejectValue(abortReason(signal));
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.cleanups.push(() => signal.removeEventListener("abort", abort));
      };
      listen(options.signal);
      listen(owner.owner.signal);
      stream.pending = pending;
    });
  }

  #flushRead(record: ProcessRecord, name: "stdout" | "stderr"): void {
    const stream = record[name];
    const pending = stream.pending;
    if (pending === undefined || (stream.bytes === 0 && !stream.eof)) return;
    stream.pending = undefined;
    for (const cleanup of pending.cleanups) cleanup();
    pending.resolve(pipeResult(stream, pending.maximum));
    this.#resumePipe(record, name);
  }

  #resumePipe(record: ProcessRecord, name: "stdout" | "stderr"): void {
    const stream = record[name];
    if (!stream.paused || stream.bytes > this.#pipeLowWaterBytes) return;
    stream.paused = false;
    record.child?.[name].resume();
  }

  async #write(
    owner: OwnerState,
    id: ExtensionProcessId,
    data: string | Uint8Array,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const record = this.#owned(owner, id);
    options.signal?.throwIfAborted();
    owner.owner.signal.throwIfAborted();
    if (record.inputClosing) throw new Error("Managed process input is closed");
    if (terminal(record.state)) throw new Error("Managed process has already finished");
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    if (chunk.length > MAX_IO_OPERATION_BYTES) throw new Error(`Managed process write exceeds ${MAX_IO_OPERATION_BYTES} bytes`);
    if (chunk.length === 0) return;
    if (
      record.queuedWriteBytes + chunk.length > MAX_QUEUED_INPUT_BYTES
      || record.queuedWriteOperations >= MAX_QUEUED_INPUT_OPERATIONS
    ) {
      throw new Error("Managed process input queue capacity is exhausted");
    }
    record.queuedWriteBytes += chunk.length;
    record.queuedWriteOperations += 1;
    const operation = record.writeTail.then(async () => {
      options.signal?.throwIfAborted();
      owner.owner.signal.throwIfAborted();
      await record.spawnReady;
      options.signal?.throwIfAborted();
      owner.owner.signal.throwIfAborted();
      if (record.inputClosing || terminal(record.state)) throw new Error("Managed process input is closed");
      const child = record.child;
      if (child === undefined) throw new Error("Managed process did not start");
      await new Promise<void>((resolveValue, rejectValue) => {
        child.stdin.write(chunk, (cause) => cause === null || cause === undefined ? resolveValue() : rejectValue(cause));
      });
    }).finally(() => {
      record.queuedWriteBytes -= chunk.length;
      record.queuedWriteOperations -= 1;
    });
    record.writeTail = operation.then(() => undefined, () => undefined);
    await withAbort(operation, [options.signal, owner.owner.signal]);
  }

  async #closeInput(
    owner: OwnerState,
    id: ExtensionProcessId,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const record = this.#owned(owner, id);
    let operation = record.closeInputOperation;
    if (operation === undefined) {
      if (record.inputClosing) return;
      record.inputClosing = true;
      operation = record.writeTail.then(async () => {
        await record.spawnReady;
        const child = record.child;
        if (child === undefined || terminal(record.state)) return;
        await new Promise<void>((resolveValue) => child.stdin.end(resolveValue));
      });
      record.closeInputOperation = operation;
      record.writeTail = operation.then(() => undefined, () => undefined);
    }
    await withAbort(operation, [options.signal, owner.owner.signal]);
  }

  async #wait(
    owner: OwnerState,
    id: ExtensionProcessId,
    options: ExtensionProcessWaitOptions = {},
  ): Promise<ExtensionProcessResult> {
    const record = this.#owned(owner, id);
    return publicResult(await withAbort(record.completion, [options.signal, owner.owner.signal]));
  }

  async #cancel(owner: OwnerState, id: ExtensionProcessId): Promise<ExtensionProcessResult> {
    const record = this.#owned(owner, id);
    if (!terminal(record.state)) this.#stop(record, "cancel");
    return publicResult(await record.completion);
  }

  #stop(
    record: ProcessRecord,
    reason: StopReason,
    cause?: unknown,
    diagnosticPrefix?: string,
  ): void {
    if (terminal(record.state) || record.stopReason !== undefined) return;
    record.stopReason = reason;
    if (cause !== undefined) {
      record.error = errorMessage(cause).slice(0, 4_096);
      if (diagnosticPrefix !== undefined) this.#diagnostic(record, cause, diagnosticPrefix);
    }
    record.state = "stopping";
    this.#notify(record, true);
    record.escalationTimer = setTimeout(() => {
      this.#terminate(record, "SIGKILL");
      record.child?.stdin.destroy();
      record.child?.stdout.destroy();
      record.child?.stderr.destroy();
    }, TERMINATION_ESCALATION_MS);
    record.escalationTimer.unref();
    record.settlementTimer = setTimeout(() => {
      const failure = new Error("Managed process did not close after process-tree termination");
      this.#diagnostic(record, failure, "Managed process cleanup forced terminal settlement");
      this.#finish(
        record,
        reason === "timeout" ? "timed_out" : reason === "cancel" ? "cancelled" : "failed",
        record.exitCode ?? null,
        record.exitSignal ?? null,
        failure,
      );
    }, TERMINATION_ESCALATION_MS + OUTPUT_DRAIN_MAX_MS);
    record.settlementTimer.unref();
    this.#terminate(record, "SIGTERM");
  }

  #terminate(record: ProcessRecord, signal: NodeJS.Signals): Promise<void> {
    const pid = record.child?.pid;
    if (pid === undefined) return Promise.resolve();
    let termination: Promise<boolean>;
    try {
      termination = this.#terminateProcess(pid, signal);
    } catch (cause) {
      this.#diagnostic(record, cause, "Managed process tree termination failed");
      return Promise.resolve();
    }
    return Promise.resolve(termination).then(
      (succeeded) => {
        if (!succeeded) {
          this.#diagnostic(
            record,
            new Error(`Could not terminate process tree ${pid} with ${signal}`),
            "Managed process tree termination failed",
          );
        }
      },
      (cause: unknown) => {
        this.#diagnostic(record, cause, "Managed process tree termination failed");
      },
    );
  }

  #finish(
    record: ProcessRecord,
    state: ExtensionProcessResult["state"],
    exitCode: number | null,
    signal: string | null,
    cause?: unknown,
  ): void {
    if (terminal(record.state)) return;
    if (cause !== undefined) record.rejectSpawn(cause);
    record.state = state;
    record.finishedAt = Date.now();
    record.exitCode = exitCode;
    record.exitSignal = signal;
    if (cause !== undefined && record.error === undefined) {
      record.error = errorMessage(cause).slice(0, 4_096);
    }
    if (record.timeoutTimer !== undefined) clearTimeout(record.timeoutTimer);
    if (record.escalationTimer !== undefined) clearTimeout(record.escalationTimer);
    if (record.drainTimer !== undefined) clearTimeout(record.drainTimer);
    if (record.settlementTimer !== undefined) clearTimeout(record.settlementTimer);
    if (record.notificationTimer !== undefined) clearTimeout(record.notificationTimer);
    if (record.ownerAbort !== undefined) {
      record.owner.owner.signal.removeEventListener("abort", record.ownerAbort);
    }
    if (record.callerSignal !== undefined && record.callerAbort !== undefined) {
      record.callerSignal.removeEventListener("abort", record.callerAbort);
    }
    record.releaseProcessGroup?.();
    record.stdout.eof = true;
    record.stderr.eof = true;
    this.#flushRead(record, "stdout");
    this.#flushRead(record, "stderr");
    const status = this.#status(record);
    const result: ExtensionProcessResult = Object.freeze({
      ...status,
      state,
      exitCode,
      signal,
      stdout: new Uint8Array(record.stdout.mode === "capture" ? Buffer.concat(record.stdout.chunks) : Buffer.alloc(0)),
      stderr: new Uint8Array(record.stderr.mode === "capture" ? Buffer.concat(record.stderr.chunks) : Buffer.alloc(0)),
    });
    record.resolveCompletion(result);
    this.#notify(record, true);
    queueMicrotask(() => {
      this.#releaseAbortedOwner(record.owner);
      this.#prune();
    });
  }

  #releaseAbortedOwner(owner: OwnerState): void {
    if (!owner.owner.signal.aborted || this.#runningCount(owner.records) > 0) return;
    owner.owner.signal.removeEventListener("abort", owner.abortListener);
    for (const record of owner.records) {
      this.#disposeRecord(record);
      this.#records.delete(record.id);
    }
    owner.records.clear();
    this.#owners.delete(owner.owner.key);
  }

  #prune(): void {
    const terminalRecords = [...this.#records.values()]
      .filter((record) => terminal(record.state))
      .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0));
    const perOwner = new Map<OwnerState, ProcessRecord[]>();
    for (const record of terminalRecords) {
      const selected = perOwner.get(record.owner) ?? [];
      selected.push(record);
      perOwner.set(record.owner, selected);
    }
    const remove = new Set<ProcessRecord>();
    for (const records of perOwner.values()) {
      while (records.length > this.#maxTerminalPerOwner) remove.add(records.shift()!);
    }
    const retained = terminalRecords.filter((record) => !remove.has(record));
    while (retained.length > this.#maxTerminal) remove.add(retained.shift()!);
    let bytes = retained.reduce((total, record) => total + record.stdout.bytes + record.stderr.bytes, 0);
    while (bytes > this.#maxTerminalBytes && retained.length > 0) {
      const record = retained.shift()!;
      if (remove.has(record)) continue;
      remove.add(record);
      bytes -= record.stdout.bytes + record.stderr.bytes;
    }
    for (const record of remove) {
      this.#disposeRecord(record);
      this.#records.delete(record.id);
      record.owner.records.delete(record);
    }
  }

  #disposeRecord(record: ProcessRecord): void {
    if (record.notificationTimer !== undefined) clearTimeout(record.notificationTimer);
    if (record.timeoutTimer !== undefined) clearTimeout(record.timeoutTimer);
    if (record.escalationTimer !== undefined) clearTimeout(record.escalationTimer);
    if (record.drainTimer !== undefined) clearTimeout(record.drainTimer);
    if (record.settlementTimer !== undefined) clearTimeout(record.settlementTimer);
    if (record.ownerAbort !== undefined) {
      record.owner.owner.signal.removeEventListener("abort", record.ownerAbort);
    }
    if (record.callerSignal !== undefined && record.callerAbort !== undefined) {
      record.callerSignal.removeEventListener("abort", record.callerAbort);
    }
    record.owner.subscriptions -= record.listeners.size;
    record.listeners.clear();
    for (const stream of [record.stdout, record.stderr]) {
      const pending = stream.pending;
      if (pending !== undefined) {
        stream.pending = undefined;
        for (const cleanup of pending.cleanups) cleanup();
        pending.reject(new Error("Managed process record was released"));
      }
      stream.chunks.length = 0;
      stream.bytes = 0;
    }
  }
}
