import type { ImageBlock } from "../core/types.js";
import type {
  EmbeddingHarness,
  EmbeddingModelSelection,
  EmbeddingSessionCompactOptions,
  EmbeddingSessionCreateOptions,
  EmbeddingSessionEventListener,
  EmbeddingSessionForkOptions,
  EmbeddingSessionOpenOptions,
  EmbeddingSessionRunOptions,
} from "../embedding/index.js";
import { createEmbeddingHarnessFromRuntime } from "../embedding/index.js";
import { RpcRuntimeDispatcher, type RpcRuntimePeer } from "../interfaces/rpc-runtime.js";
import type {
  RpcMethod,
  RpcMethodParams,
  RpcMethodResult,
} from "../interfaces/rpc-protocol.js";
import type { HarnessRuntime } from "../public-runtime.js";
import { acquireOwnedRuntime, type OwnedRuntimeLease } from "../internal/runtime-owner.js";
import type { HarnessRun } from "../service/harness.js";
import type { HarnessResourceCatalog } from "../service/resource-catalog.js";
import type { HarnessSessionListRequest, HarnessSessionPage } from "../service/session-catalog.js";
import type { HarnessTranscriptPage, HarnessTranscriptRequest } from "../service/transcript.js";
import { TuiController } from "../tui/controller.js";
import type {
  TuiAction,
  TuiControllerOptions,
  TuiInputImageAttachment,
} from "../tui/types.js";
import { createOwnedInteractiveModeHost } from "./owned-interactive.js";
export { OWNED_INTERACTIVE_COMMANDS } from "./owned-interactive.js";

/** The session surface required by the ready-made print and interactive modes. */
export interface ModeSession {
  readonly threadId: string;
  readonly branch: string;
  run(options: EmbeddingSessionRunOptions): Promise<HarnessRun>;
  steer(message: string, images?: ImageBlock[]): void;
  followUp(message: string, images?: ImageBlock[]): void;
  abort(reason?: string): void;
  getModel(): EmbeddingModelSelection | undefined;
  /** Optional durable presentation surface used by a full embedded interaction host. */
  transcript?(input?: Omit<HarnessTranscriptRequest, "threadId" | "branch">): Promise<HarnessTranscriptPage>;
  /** Optional model mutation authority used by a full embedded interaction host. */
  setModel?(selection: EmbeddingModelSelection, signal?: AbortSignal): Promise<EmbeddingModelSelection>;
  /** Optional manual compaction authority used by a full embedded interaction host. */
  compact?(options?: EmbeddingSessionCompactOptions): Promise<unknown>;
  /** Optional session naming authority used by a full embedded interaction host. */
  setName?(name?: string, signal?: AbortSignal): Promise<void>;
  /** Optional session forking authority used by a full embedded interaction host. */
  fork?(options?: EmbeddingSessionForkOptions): Promise<ModeSession>;
}

/** A narrow owner such as `EmbeddingHarness` or `RigynSdk`. */
export interface ModeSessionOwner {
  createSession(options?: EmbeddingSessionCreateOptions): Promise<ModeSession>;
  openSession(options: EmbeddingSessionOpenOptions): Promise<ModeSession>;
}

/** Public owner capabilities consumed by the opt-in full embedded interaction host. */
export interface InteractiveModeOwner extends ModeSessionOwner {
  listSessions(options?: HarnessSessionListRequest): Promise<HarnessSessionPage>;
  resourceCatalog(signal?: AbortSignal): Promise<HarnessResourceCatalog>;
  reload(options?: { signal?: AbortSignal }): Promise<{ warnings: string[] }>;
}

export type ModeSessionSource = ModeSession | ModeSessionOwner;
export type ModeSessionTarget = EmbeddingSessionCreateOptions | EmbeddingSessionOpenOptions;

function isModeSession(source: ModeSessionSource): source is ModeSession {
  return "threadId" in source && typeof source.threadId === "string";
}

async function modeSession(
  source: ModeSessionSource,
  target: ModeSessionTarget | undefined,
): Promise<ModeSession> {
  if (isModeSession(source)) {
    if (target !== undefined) throw new Error("A session target cannot be supplied with an existing mode session");
    return source;
  }
  if (target !== undefined && "threadId" in target) return await source.openSession(target);
  return await source.createSession(target);
}

export type PrintModeWriter = (chunk: string) => void | Promise<void>;

export interface PrintModeOptions extends Omit<EmbeddingSessionRunOptions, "prompt" | "onEvent"> {
  prompts: string | readonly string[];
  session?: ModeSessionTarget;
  format?: "text" | "json";
  write?: PrintModeWriter;
  onEvent?: EmbeddingSessionEventListener;
}

export interface PrintModeResult {
  threadId: string;
  branch: string;
  runs: HarnessRun[];
  finalText?: string;
}

async function standardOutput(chunk: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(chunk, (error) => error === null || error === undefined ? resolve() : reject(error));
  });
}

/** Runs one or more prompts through a borrowed owner and writes final text or JSON event lines. */
export async function runPrintMode(
  source: ModeSessionSource,
  options: PrintModeOptions,
): Promise<PrintModeResult> {
  const {
    prompts: inputPrompts,
    session: target,
    format = "text",
    write = standardOutput,
    onEvent,
    ...runOptions
  } = options;
  const prompts = typeof inputPrompts === "string" ? [inputPrompts] : [...inputPrompts];
  if (prompts.length === 0) throw new Error("Print mode requires at least one prompt");
  if (prompts.some((prompt) => typeof prompt !== "string" || prompt.trim() === "")) {
    throw new Error("Print mode prompts must be non-empty strings");
  }
  const session = await modeSession(source, target);
  const runs: HarnessRun[] = [];
  let finalText: string | undefined;
  for (const prompt of prompts) {
    const run = await session.run({
      ...runOptions,
      prompt,
      onEvent: async (event) => {
        if (format === "json") await write(`${JSON.stringify(event)}\n`);
        if (onEvent !== undefined) await onEvent(event);
      },
    });
    runs.push(run);
    const text = run.results.at(-1)?.finalText;
    if (text !== undefined) finalText = text;
    if (format === "text" && text !== undefined) await write(`${text}\n`);
  }
  return {
    threadId: session.threadId,
    branch: session.branch,
    runs,
    ...(finalText === undefined ? {} : { finalText }),
  };
}

export interface InteractiveModeOptions {
  run?: Omit<EmbeddingSessionRunOptions, "prompt" | "displayPrompt" | "images" | "onEvent">;
  terminal?: Omit<TuiControllerOptions, "onAction">;
  initialPrompts?: readonly string[];
  inputLabel?: string;
  startup?: { compact: string; expanded?: string };
  signal?: AbortSignal;
  onEvent?: EmbeddingSessionEventListener;
  /** Opt-in policy and authority adapter for history, commands, pickers, authentication, and extension UI. */
  host?: InteractiveModeHost;
}

export interface RunInteractiveModeOptions extends InteractiveModeOptions {
  session?: ModeSessionTarget;
}

export interface InteractiveModeResult {
  threadId: string;
  branch: string;
  runs: HarnessRun[];
  finalText?: string;
}

export type InteractiveModeRouteResult =
  | { action: "handled" }
  | { action: "submit"; text: string; images?: ImageBlock[] };

/** Mutable focus supplied to an interaction host without exposing a store or service object. */
export interface InteractiveModeHostContext {
  readonly terminal: TuiController;
  readonly signal: AbortSignal;
  session(): ModeSession;
  replaceSession(session: ModeSession): Promise<void>;
  /** Routes one host-originated submission through the same command and run path as editor input. */
  submit(text: string, images?: readonly ImageBlock[]): Promise<boolean>;
  close(reason?: unknown): void;
}

/** Optional interaction-policy adapter. Implementations retain only authority explicitly supplied by their owner. */
export interface InteractiveModeHost {
  attach(context: InteractiveModeHostContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  repaint(context: InteractiveModeHostContext): void | Promise<void>;
  route(
    text: string,
    images: readonly ImageBlock[],
    context: InteractiveModeHostContext,
  ): InteractiveModeRouteResult | Promise<InteractiveModeRouteResult>;
  action?(action: TuiAction, context: InteractiveModeHostContext): boolean | Promise<boolean>;
}

export interface OwnedInteractiveModeOptions extends RunInteractiveModeOptions {
  /** Do not attempt to open a browser during an interactive authorization flow. */
  noBrowser?: boolean;
  /** Maximum durable events restored into the terminal. */
  historyEvents?: number;
  /** Maximum serialized durable history restored into the terminal. */
  historyBytes?: number;
  /** Host-owned policies that are intentionally not inferred from a borrowed runtime. */
  delegatedCommands?: Partial<Record<OwnedInteractiveDelegatedCommand, OwnedInteractiveDelegatedCommandHandler>>;
  /** Platform/application actions that require authority outside the borrowed runtime. */
  delegatedActions?: Partial<Record<OwnedInteractiveDelegatedAction, OwnedInteractiveDelegatedActionHandler>>;
}

export type OwnedInteractiveDelegatedCommand =
  | "settings"
  | "llama"
  | "scoped-models"
  | "export"
  | "share"
  | "changelog"
  | "import"
  | "context"
  | "fork"
  | "tree"
  | "trust";

export type OwnedInteractiveDelegatedCommandHandler = (
  args: string,
  context: InteractiveModeHostContext,
) => void | InteractiveModeRouteResult | Promise<void | InteractiveModeRouteResult>;

export type OwnedInteractiveDelegatedAction =
  | "paste_image"
  | "dequeue"
  | "queue_restore_discard"
  | "provider_select"
  | "file_select";

export type OwnedInteractiveDelegatedActionHandler = (
  action: TuiAction,
  context: InteractiveModeHostContext,
) => void | Promise<void>;

function imageBlocks(
  attachments: readonly TuiInputImageAttachment[] | undefined,
  recovered: readonly ImageBlock[] | undefined,
): ImageBlock[] {
  return [
    ...(attachments ?? []).map((attachment) => ({ ...attachment.block })),
    ...(recovered ?? []).map((image) => ({ ...image })),
  ];
}

/** A ready-made terminal conversation loop over one borrowed session. */
export class InteractiveMode {
  readonly terminal: TuiController;
  #session: ModeSession;
  readonly #options: InteractiveModeOptions;
  #initialSelection: EmbeddingModelSelection | undefined;
  readonly #lifecycle = new AbortController();
  readonly #runs: HarnessRun[] = [];
  #active = false;
  #running = false;
  #failure: Error | undefined;
  #removeExternalAbort: (() => void) | undefined;
  #detachHost: (() => void | Promise<void>) | undefined;
  #hostActionTail: Promise<void> = Promise.resolve();
  #hostContextValue: InteractiveModeHostContext | undefined;

  constructor(session: ModeSession, options: InteractiveModeOptions = {}) {
    this.#session = session;
    this.#options = options;
    this.#initialSelection = options.run?.selection === undefined ? undefined : { ...options.run.selection };
    this.terminal = new TuiController({
      ...options.terminal,
      onAction: (action) => this.#action(action),
    });
    if (options.signal !== undefined) {
      const onAbort = (): void => this.close(options.signal?.reason);
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.#removeExternalAbort = () => options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) onAbort();
    }
  }

  async run(): Promise<InteractiveModeResult> {
    if (this.#running) throw new Error("Interactive mode can only be run once");
    if (this.#lifecycle.signal.aborted) throw new Error("Interactive mode is closed");
    this.#running = true;
    this.terminal.start();
    const startup = this.#options.startup ?? {
      compact: "Rigyn embedded mode · Ready",
      expanded: "Rigyn embedded mode · Ready\nThe embedding owner remains responsible for reload and cleanup.",
    };
    this.terminal.setStartup(startup.compact, startup.expanded ?? startup.compact);
    try {
      const initialSelection = this.#initialSelection;
      if (initialSelection !== undefined && this.#session.setModel !== undefined) {
        await this.#session.setModel(initialSelection, this.#lifecycle.signal);
        this.#initialSelection = undefined;
      }
      this.#syncContext(false);
      if (this.#options.host !== undefined) {
        const detach = await this.#options.host.attach(this.#hostContext());
        if (detach !== undefined) this.#detachHost = detach;
        await this.#options.host.repaint(this.#hostContext());
      }
      for (const prompt of this.#options.initialPrompts ?? []) {
        if (!await this.#submit(prompt, [])) break;
      }
      while (!this.#lifecycle.signal.aborted) {
        let prompt: string;
        try {
          prompt = await this.terminal.question(
            this.#options.inputLabel ?? "you> ",
            this.#lifecycle.signal,
            { cancelable: false },
          );
        } catch (error) {
          if (this.#lifecycle.signal.aborted) break;
          throw error;
        }
        const images = imageBlocks(
          this.terminal.takeSubmittedImages(),
          this.terminal.takeSubmittedRecoveredImages(),
        );
        if (!await this.#submit(prompt, images)) break;
      }
    } finally {
      this.close();
    }
    if (this.#failure !== undefined) throw this.#failure;
    const finalText = this.#runs.at(-1)?.results.at(-1)?.finalText;
    return {
      threadId: this.#session.threadId,
      branch: this.#session.branch,
      runs: [...this.#runs],
      ...(finalText === undefined ? {} : { finalText }),
    };
  }

  close(reason?: unknown): void {
    if (this.#lifecycle.signal.aborted) return;
    if (this.#active) {
      try { this.#session.abort(reason instanceof Error ? reason.message : "Interactive mode closed"); } catch {}
    }
    this.#lifecycle.abort(reason instanceof Error ? reason : new Error("Interactive mode closed"));
    this.#removeExternalAbort?.();
    this.#removeExternalAbort = undefined;
    const detach = this.#detachHost;
    this.#detachHost = undefined;
    if (detach !== undefined) void Promise.resolve(detach()).catch(() => undefined);
    this.terminal.close();
  }

  async #submit(prompt: string, images: ImageBlock[]): Promise<boolean> {
    const command = prompt.trim();
    if (command === "/exit" || command === "/quit") {
      this.close();
      return false;
    }
    if (command === "" && images.length === 0) return true;
    if (command === "/cancel") {
      this.terminal.notify("No run is active", "warning");
      return true;
    }
    if (this.#options.host !== undefined) {
      try {
        const routed = await this.#options.host.route(prompt, images, this.#hostContext());
        if (routed.action === "handled") return !this.#lifecycle.signal.aborted;
        prompt = routed.text;
        images = routed.images === undefined ? images : routed.images.map((image) => ({ ...image }));
      } catch (error) {
        if (!this.#lifecycle.signal.aborted) {
          this.terminal.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return !this.#lifecycle.signal.aborted;
      }
    }
    const { selection: _initialSelection, ...runOptions } = this.#options.run ?? {};
    const activeSelection = this.#initialSelection ?? this.#session.getModel();
    this.#initialSelection = undefined;
    const selectedSignal = runOptions.signal === undefined
      ? this.#lifecycle.signal
      : AbortSignal.any([runOptions.signal, this.#lifecycle.signal]);
    this.#active = true;
    this.#syncContext(true);
    this.terminal.setInterruptHandler(() => this.#session.abort("Run cancelled from terminal"));
    this.terminal.setSteering((text, attachments, recovered) => {
      const blocks = imageBlocks(attachments, recovered);
      try {
        if (text === "/cancel") this.#session.abort("Run cancelled from terminal");
        else if (text.startsWith("/follow ")) this.#session.followUp(text.slice(8), blocks);
        else this.#session.steer(text, blocks);
      } catch (error) {
        this.terminal.notify(error instanceof Error ? error.message : String(error), "error");
      }
    });
    try {
      const run = await this.#session.run({
        ...runOptions,
        ...(activeSelection === undefined ? {} : { selection: activeSelection }),
        prompt,
        displayPrompt: prompt,
        ...(images.length === 0 ? {} : { images }),
        signal: selectedSignal,
        onEvent: async (event) => {
          this.terminal.render(event);
          if (this.#options.onEvent !== undefined) await this.#options.onEvent(event);
        },
      });
      this.#runs.push(run);
    } catch (error) {
      if (!this.#lifecycle.signal.aborted) {
        this.terminal.notify(`Run failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } finally {
      this.#active = false;
      this.terminal.setSteering(undefined);
      this.terminal.setInterruptHandler(undefined);
      this.#syncContext(false);
    }
    return !this.#lifecycle.signal.aborted;
  }

  #syncContext(active: boolean): void {
    const selection = this.#initialSelection ?? this.#session.getModel();
    this.terminal.setContext({
      threadId: this.#session.threadId,
      ...(selection === undefined
        ? {}
        : {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { thinking: selection.reasoningEffort }),
          }),
      active,
      status: active ? "streaming" : "idle",
    });
  }

  #action(action: TuiAction): void {
    if (action.type === "cancel") {
      if (this.#active) this.#session.abort("Run cancelled from terminal");
      return;
    }
    if (action.type === "exit" || action.type === "signal") {
      this.close(action.type === "signal" ? new Error(`Interrupted by ${action.signal}`) : undefined);
      return;
    }
    if (action.type === "copy_text") {
      try { this.terminal.copyToClipboard(action.text); } catch (error) {
        this.terminal.notify(error instanceof Error ? error.message : String(error), "warning");
      }
      return;
    }
    if (action.type === "steer" || action.type === "follow_up") {
      try {
        const blocks = imageBlocks(action.images, action.recoveredImages);
        if (action.type === "steer") this.#session.steer(action.text, blocks);
        else this.#session.followUp(action.text, blocks);
      } catch (error) {
        this.terminal.notify(error instanceof Error ? error.message : String(error), "error");
      }
      return;
    }
    if (action.type === "error") {
      this.#failure = action.error;
      this.close(action.error);
      return;
    }
    if (this.#options.host !== undefined) {
      this.#hostActionTail = this.#hostActionTail.then(async () => {
        if (this.#lifecycle.signal.aborted) return;
        try {
          await this.#options.host?.action?.(action, this.#hostContext());
        } catch (error) {
          if (!this.#lifecycle.signal.aborted) {
            this.terminal.notify(error instanceof Error ? error.message : String(error), "error");
          }
        }
      });
    }
  }

  #hostContext(): InteractiveModeHostContext {
    this.#hostContextValue ??= {
      terminal: this.terminal,
      signal: this.#lifecycle.signal,
      session: () => this.#session,
      replaceSession: async (session) => {
        if (this.#active) throw new Error("Wait for the active response to finish before switching sessions");
        this.#session = session;
        this.#syncContext(false);
        await this.#options.host?.repaint(this.#hostContext());
      },
      submit: async (text, images = []) => {
        if (this.#active) throw new Error("Wait for the active response to finish before submitting another command");
        return await this.#submit(text, images.map((image) => ({ ...image })));
      },
      close: (reason) => this.close(reason),
    };
    return this.#hostContextValue;
  }
}

/** Resolves a session from a borrowed owner, runs the terminal loop, and leaves the owner open. */
export async function runInteractiveMode(
  source: ModeSessionSource,
  options: RunInteractiveModeOptions = {},
): Promise<InteractiveModeResult> {
  const { session: target, ...interactiveOptions } = options;
  const session = await modeSession(source, target);
  return await new InteractiveMode(session, interactiveOptions).run();
}

/**
 * Runs the full embedded terminal policy over one already-owned runtime.
 * The runtime is borrowed exclusively and remains open after this function returns.
 */
export async function runOwnedInteractiveMode(
  runtime: HarnessRuntime,
  options: OwnedInteractiveModeOptions = {},
): Promise<InteractiveModeResult> {
  const lease = acquireOwnedRuntime(runtime);
  const owner: EmbeddingHarness = createEmbeddingHarnessFromRuntime(runtime);
  const {
    session: target,
    noBrowser,
    historyEvents,
    historyBytes,
    delegatedCommands,
    delegatedActions,
    host: suppliedHost,
    ...interactiveOptions
  } = options;
  if (suppliedHost !== undefined) {
    lease.release();
    throw new Error("runOwnedInteractiveMode creates its own runtime interaction host; use runInteractiveMode for a custom host");
  }
  const host = createOwnedInteractiveModeHost(lease.runtime, owner, {
    ...(noBrowser === undefined ? {} : { noBrowser }),
    ...(historyEvents === undefined ? {} : { historyEvents }),
    ...(historyBytes === undefined ? {} : { historyBytes }),
    ...(delegatedCommands === undefined ? {} : { delegatedCommands }),
    ...(delegatedActions === undefined ? {} : { delegatedActions }),
  });
  try {
    const session = await modeSession(owner, target);
    return await new InteractiveMode(session, { ...interactiveOptions, host }).run();
  } finally {
    await host.dispose();
    lease.release();
  }
}

export interface RpcModeOptions {
  peerId?: string;
  requestShutdown?: () => void;
}

export interface RpcModeNotification {
  method: string;
  params?: unknown;
}

export type RpcModeNotificationListener = (
  notification: Readonly<RpcModeNotification>,
) => void | Promise<void>;

/** A typed, in-process RPC peer over a borrowed advanced runtime owner. */
export class RpcMode {
  readonly #dispatcher: RpcRuntimeDispatcher;
  readonly #peer: RpcRuntimePeer;
  readonly #listeners = new Set<RpcModeNotificationListener>();
  readonly #ownerLease: OwnedRuntimeLease;
  #closing: Promise<void> | undefined;

  constructor(runtime: HarnessRuntime, options: RpcModeOptions = {}) {
    const peerId = options.peerId ?? "in-process";
    if (peerId.trim() === "" || Buffer.byteLength(peerId, "utf8") > 1_024) {
      throw new Error("RPC mode peerId must be a non-empty string of at most 1024 bytes");
    }
    this.#peer = {
      id: peerId,
      notification: async (method, params) => {
        const notification = { method, ...(params === undefined ? {} : { params }) };
        for (const listener of [...this.#listeners]) await listener(notification);
      },
    };
    this.#ownerLease = acquireOwnedRuntime(runtime);
    try {
      this.#dispatcher = new RpcRuntimeDispatcher({
        runtime: this.#ownerLease.runtime,
        ...(options.requestShutdown === undefined ? {} : { requestShutdown: options.requestShutdown }),
      });
      this.#dispatcher.connect(this.#peer);
    } catch (error) {
      this.#ownerLease.release();
      throw error;
    }
  }

  async request<K extends RpcMethod>(
    method: K,
    ...input: undefined extends RpcMethodParams<K>
      ? [params?: RpcMethodParams<K>]
      : [params: RpcMethodParams<K>]
  ): Promise<RpcMethodResult<K>> {
    if (this.#closing !== undefined) throw new Error("RPC mode is closing");
    const params = input[0];
    return await this.#dispatcher.dispatch(this.#peer, {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    }) as RpcMethodResult<K>;
  }

  subscribe(listener: RpcModeNotificationListener): () => void {
    if (this.#closing !== undefined) throw new Error("RPC mode is closing");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(reason = "In-process RPC mode closed", graceMs = 5_000): Promise<void> {
    this.#closing ??= (async () => {
      this.#dispatcher.disconnect(this.#peer.id);
      try {
        await this.#dispatcher.close(reason, graceMs);
      } finally {
        this.#listeners.clear();
        this.#ownerLease.release();
      }
    })();
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export function createRpcMode(runtime: HarnessRuntime, options: RpcModeOptions = {}): RpcMode {
  return new RpcMode(runtime, options);
}

/** Runs a scoped in-process RPC operation without taking ownership of the runtime. */
export async function runRpcMode<T>(
  runtime: HarnessRuntime,
  operation: (mode: RpcMode) => T | Promise<T>,
  options: RpcModeOptions = {},
): Promise<T> {
  const mode = createRpcMode(runtime, options);
  try {
    return await operation(mode);
  } finally {
    await mode.close();
  }
}
