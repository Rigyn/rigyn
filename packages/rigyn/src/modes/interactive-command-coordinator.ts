import { interactiveCommand } from "../interactive/commands.js";
import type { TuiAction } from "../tui/types.js";

export const INTERACTIVE_BUILTIN_COMMANDS = [
  "cancel",
  "changelog",
  "clone",
  "compact",
  "context",
  "copy",
  "export",
  "fork",
  "help",
  "hotkeys",
  "import",
  "llama",
  "login",
  "logout",
  "model",
  "name",
  "new",
  "quit",
  "reload",
  "resources",
  "resume",
  "scoped-models",
  "session",
  "settings",
  "share",
  "thinking",
  "tree",
  "trust",
] as const;

export type InteractiveBuiltinCommand = typeof INTERACTIVE_BUILTIN_COMMANDS[number];

export interface InteractiveCommandRequest<TImage> {
  /** Canonical built-in command name. */
  command: InteractiveBuiltinCommand;
  /** Whitespace-normalized command arguments. */
  args: string;
  /** Original submitted slash line. */
  input: string;
  images: readonly TImage[];
}

export interface InteractiveUnknownCommandRequest<TImage> {
  command: string;
  args: string;
  input: string;
  images: readonly TImage[];
}

export type InteractiveCommandHandlers<TImage> = Readonly<Record<
  InteractiveBuiltinCommand,
  (request: InteractiveCommandRequest<TImage>) => void | Promise<void>
>>;

export interface InteractiveShellRequest {
  command: string;
  hidden: boolean;
  input: string;
}

export interface InteractiveSubmissionHandlers<TImage> {
  prompt(text: string, images: readonly TImage[]): void | Promise<void>;
  shell(request: InteractiveShellRequest): void | Promise<void>;
}

type ActionOf<T extends TuiAction["type"]> = Extract<TuiAction, { type: T }>;

export interface InteractiveActionHandlers {
  exit(action: ActionOf<"exit"> | ActionOf<"signal">): void | Promise<void>;
  error(action: ActionOf<"error">): void | Promise<void>;
  cancel(action: ActionOf<"cancel">): void | Promise<void>;
  submit(action: ActionOf<"submit">): void | Promise<void>;
  activeSubmission(action: ActionOf<"steer"> | ActionOf<"follow_up">): void | Promise<void>;
  dequeue(action: ActionOf<"dequeue">): void | Promise<void>;
  queueRestoreDiscard(action: ActionOf<"queue_restore_discard">): void | Promise<void>;
  sessionCatalog(action:
    | ActionOf<"session_open">
    | ActionOf<"session_scope">
    | ActionOf<"session_search">
    | ActionOf<"session_more">
  ): void | Promise<void>;
  sessionMutation(action: ActionOf<"session_rename"> | ActionOf<"session_delete">): void | Promise<void>;
  selectSession(action: ActionOf<"select">): void | Promise<void>;
  selectModel(action: ActionOf<"select">): void | Promise<void>;
  command(action: ActionOf<"command">): void | Promise<void>;
  copy(action: ActionOf<"copy">): void | Promise<void>;
  copyText(action: ActionOf<"copy_text">): void | Promise<void>;
  cycleThinking(action: ActionOf<"cycle_thinking">): void | Promise<void>;
  extensionShortcut(action: ActionOf<"extension_shortcut">): void | Promise<void>;
  other(action:
    | ActionOf<"paste_image">
    | ActionOf<"suspend">
    | ActionOf<"select">
  ): void | Promise<void>;
}

export interface InteractiveCommandCoordinatorOptions<TImage> {
  commands: InteractiveCommandHandlers<TImage>;
  unknownCommand(request: InteractiveUnknownCommandRequest<TImage>): boolean | Promise<boolean>;
  submissions: InteractiveSubmissionHandlers<TImage>;
  actions: InteractiveActionHandlers;
}

const BUILTINS = new Set<string>(INTERACTIVE_BUILTIN_COMMANDS);

function parseSlash<TImage>(input: string, images: readonly TImage[]): InteractiveUnknownCommandRequest<TImage> {
  const [head, ...parts] = input.slice(1).trim().split(/\s+/u);
  return {
    command: head ?? "",
    args: parts.join(" "),
    input,
    images,
  };
}

/** Shared command, submission, and TUI-action router for every interactive host. */
export class InteractiveCommandCoordinator<TImage> {
  readonly #options: InteractiveCommandCoordinatorOptions<TImage>;

  constructor(options: InteractiveCommandCoordinatorOptions<TImage>) {
    this.#options = options;
  }

  async dispatchSlash(input: string, images: readonly TImage[] = []): Promise<boolean> {
    if (!input.startsWith("/")) return false;
    const parsed = parseSlash(input, images);
    const definition = interactiveCommand(parsed.command);
    const canonical = definition?.aliasFor ?? parsed.command;
    if (!BUILTINS.has(canonical)) return await this.#options.unknownCommand(parsed);
    const command = canonical as InteractiveBuiltinCommand;
    await this.#options.commands[command]({ ...parsed, command });
    return true;
  }

  async dispatchSubmission(text: string, images: readonly TImage[] = []): Promise<void> {
    if (text.startsWith("/")) {
      if (await this.dispatchSlash(text, images)) return;
      await this.#options.submissions.prompt(text, images);
      return;
    }
    if (text.startsWith("!")) {
      if (images.length > 0) throw new Error("Shell shortcuts do not accept image attachments");
      const hidden = text.startsWith("!!");
      await this.#options.submissions.shell({
        command: text.slice(hidden ? 2 : 1).trim(),
        hidden,
        input: text,
      });
      return;
    }
    await this.#options.submissions.prompt(text, images);
  }

  async dispatchAction(action: TuiAction): Promise<void> {
    if (action.type === "exit" || action.type === "signal") return await this.#options.actions.exit(action);
    if (action.type === "error") return await this.#options.actions.error(action);
    if (action.type === "cancel") return await this.#options.actions.cancel(action);
    if (action.type === "submit") return await this.#options.actions.submit(action);
    if (action.type === "steer" || action.type === "follow_up") return await this.#options.actions.activeSubmission(action);
    if (action.type === "dequeue") return await this.#options.actions.dequeue(action);
    if (action.type === "queue_restore_discard") return await this.#options.actions.queueRestoreDiscard(action);
    if (
      action.type === "session_open" || action.type === "session_scope" ||
      action.type === "session_search" || action.type === "session_more"
    ) return await this.#options.actions.sessionCatalog(action);
    if (action.type === "session_rename" || action.type === "session_delete") {
      return await this.#options.actions.sessionMutation(action);
    }
    if (action.type === "select" && action.picker === "session") return await this.#options.actions.selectSession(action);
    if (action.type === "select" && action.picker === "model") return await this.#options.actions.selectModel(action);
    if (action.type === "command") return await this.#options.actions.command(action);
    if (action.type === "copy") return await this.#options.actions.copy(action);
    if (action.type === "copy_text") return await this.#options.actions.copyText(action);
    if (action.type === "cycle_thinking") return await this.#options.actions.cycleThinking(action);
    if (action.type === "extension_shortcut") return await this.#options.actions.extensionShortcut(action);
    return await this.#options.actions.other(action);
  }
}
