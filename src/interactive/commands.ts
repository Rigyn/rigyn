export type InteractiveActivePolicy = "cancel" | "follow_up" | "defer";

export interface InteractiveCommandDefinition {
  /** Exact slash name without the leading slash. */
  name: string;
  /** Canonical command name when this entry is an alias. */
  aliasFor?: string;
  syntax: string;
  activePolicy: InteractiveActivePolicy;
  hidden: boolean;
  palette?: {
    id: string;
    label: string;
    detail: string;
    value: string;
    keywords?: readonly string[];
  };
  help: boolean;
}

const DEFER = "defer" as const;

/** Single source of truth for built-in interactive command names and presentation. */
export const INTERACTIVE_COMMANDS: readonly InteractiveCommandDefinition[] = [
  { name: "settings", syntax: "settings", activePolicy: DEFER, hidden: false, help: true, palette: { id: "settings", label: "Open settings menu", detail: "/settings", value: "/settings" } },
  { name: "model", syntax: "model [PROVIDER/MODEL]", activePolicy: DEFER, hidden: false, help: true, palette: { id: "model", label: "Select model", detail: "/model", value: "/model" } },
  { name: "scoped-models", syntax: "scoped-models", activePolicy: DEFER, hidden: false, help: true, palette: { id: "scoped-models", label: "Configure model cycling", detail: "/scoped-models", value: "/scoped-models" } },
  { name: "export", syntax: "export [--redact] [FILE]", activePolicy: DEFER, hidden: false, help: true, palette: { id: "export", label: "Export session", detail: "/export [--redact] [FILE]", value: "/export" } },
  { name: "import", syntax: "import [FILE]", activePolicy: DEFER, hidden: false, help: true, palette: { id: "import", label: "Import session", detail: "/import [FILE]", value: "/import" } },
  { name: "copy", syntax: "copy", activePolicy: DEFER, hidden: false, help: true, palette: { id: "copy", label: "Copy last assistant message", detail: "/copy", value: "/copy" } },
  { name: "name", syntax: "name [NAME]", activePolicy: DEFER, hidden: false, help: true, palette: { id: "name", label: "Set session name", detail: "/name [NAME]", value: "/name" } },
  { name: "session", syntax: "session", activePolicy: DEFER, hidden: false, help: true, palette: { id: "session", label: "Show session information", detail: "/session", value: "/session" } },
  { name: "context", syntax: "context", activePolicy: DEFER, hidden: false, help: true, palette: { id: "context", label: "Show model context provenance", detail: "/context", value: "/context" } },
  { name: "resources", syntax: "resources", activePolicy: DEFER, hidden: false, help: true, palette: { id: "resources", label: "Show loaded resources", detail: "/resources", value: "/resources" } },
  { name: "hotkeys", syntax: "hotkeys", activePolicy: DEFER, hidden: false, help: true, palette: { id: "hotkeys", label: "Show keyboard shortcuts", detail: "/hotkeys", value: "/hotkeys" } },
  { name: "fork", syntax: "fork", activePolicy: DEFER, hidden: false, help: true, palette: { id: "fork", label: "Fork from an earlier message", detail: "/fork", value: "/fork" } },
  { name: "clone", syntax: "clone [NAME]", activePolicy: DEFER, hidden: false, help: true, palette: { id: "clone", label: "Clone current session", detail: "/clone", value: "/clone" } },
  { name: "tree", syntax: "tree", activePolicy: DEFER, hidden: false, help: true, palette: { id: "tree", label: "Navigate session tree", detail: "/tree", value: "/tree" } },
  { name: "trust", syntax: "trust", activePolicy: DEFER, hidden: false, help: true, palette: { id: "trust", label: "Save project trust", detail: "/trust", value: "/trust" } },
  { name: "login", syntax: "login [PROVIDER]", activePolicy: DEFER, hidden: false, help: true, palette: { id: "login", label: "Configure provider authentication", detail: "/login", value: "/login" } },
  { name: "logout", syntax: "logout [PROVIDER]", activePolicy: DEFER, hidden: false, help: true, palette: { id: "logout", label: "Remove provider authentication", detail: "/logout", value: "/logout" } },
  { name: "new", syntax: "new", activePolicy: DEFER, hidden: false, help: true, palette: { id: "new", label: "Start a new session", detail: "/new", value: "/new" } },
  { name: "compact", syntax: "compact [INSTRUCTIONS]", activePolicy: DEFER, hidden: false, help: true, palette: { id: "compact", label: "Compact session context", detail: "/compact", value: "/compact" } },
  { name: "resume", syntax: "resume", activePolicy: DEFER, hidden: false, help: true, palette: { id: "resume", label: "Resume another session", detail: "/resume", value: "/resume" } },
  { name: "reload", syntax: "reload", activePolicy: DEFER, hidden: false, help: true, palette: { id: "reload", label: "Reload resources", detail: "/reload", value: "/reload" } },
  { name: "quit", syntax: "quit", activePolicy: DEFER, hidden: false, help: true, palette: { id: "quit", label: "Quit", detail: "/quit", value: "/quit" } },

  { name: "exit", aliasFor: "quit", syntax: "exit", activePolicy: DEFER, hidden: true, help: false },
  { name: "cancel", syntax: "cancel", activePolicy: "cancel", hidden: true, help: false },
  { name: "follow", syntax: "follow [MESSAGE]", activePolicy: "follow_up", hidden: true, help: false },
  { name: "prompt", syntax: "prompt ID [INPUT]", activePolicy: DEFER, hidden: true, help: false },
  { name: "skill", syntax: "skill:NAME [INPUT]", activePolicy: DEFER, hidden: true, help: false },
];

const BY_NAME = new Map(INTERACTIVE_COMMANDS.map((command) => [command.name, command]));

export function interactiveCommand(name: string): InteractiveCommandDefinition | undefined {
  return BY_NAME.get(name);
}

export function interactiveCommandNames(): string[] {
  return [...BY_NAME.keys()].sort((left, right) => left.localeCompare(right));
}

export function interactiveCommandPalette(): Array<NonNullable<InteractiveCommandDefinition["palette"]>> {
  return INTERACTIVE_COMMANDS.flatMap((command) => command.palette === undefined ? [] : [{
    ...command.palette,
    ...(command.palette.keywords === undefined ? {} : { keywords: [...command.palette.keywords] }),
  }]);
}

export interface InteractiveExportRequest {
  redact: boolean;
  pathArgument: string;
}

export function parseInteractiveExportRequest(value: string): InteractiveExportRequest {
  const trimmed = value.trim();
  if (trimmed === "--redact") return { redact: true, pathArgument: "" };
  if (trimmed.startsWith("--redact") && /^\s/u.test(trimmed.slice("--redact".length))) {
    return { redact: true, pathArgument: trimmed.slice("--redact".length).trimStart() };
  }
  return { redact: false, pathArgument: trimmed };
}

export function renderInteractiveCommandHelp(): string {
  const commands = INTERACTIVE_COMMANDS.filter((command) => command.help && !command.hidden)
    .map((command) => `/${command.syntax}`);
  const commandLines: string[] = [];
  for (const command of commands) {
    const current = commandLines.at(-1);
    if (current === undefined || `${current}  ${command}`.length > 76) commandLines.push(`  ${command}`);
    else commandLines[commandLines.length - 1] = `${current}  ${command}`;
  }
  return [
    "Interactive commands:",
    ...commandLines,
  ].join("\n");
}
