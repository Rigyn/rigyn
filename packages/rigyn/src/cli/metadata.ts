export const CLI_MODE_VALUES = ["text", "json", "rpc"] as const;
export const CLI_THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const CLI_COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

export interface CliOptionMetadata {
  name: string;
  long: `--${string}`;
  short?: `-${string}`;
  value?: string;
  values?: readonly string[];
  optionalValue?: boolean;
}

export const AGENT_CLI_OPTIONS = [
  { name: "help", long: "--help", short: "-h" },
  { name: "version", long: "--version", short: "-v" },
  { name: "mode", long: "--mode", value: "MODE", values: CLI_MODE_VALUES },
  { name: "continue", long: "--continue", short: "-c" },
  { name: "resume", long: "--resume", short: "-r" },
  { name: "all", long: "--all" },
  { name: "provider", long: "--provider", value: "NAME" },
  { name: "model", long: "--model", value: "PATTERN" },
  { name: "api-key", long: "--api-key", value: "KEY" },
  { name: "system-prompt", long: "--system-prompt", value: "TEXT" },
  { name: "append-system-prompt", long: "--append-system-prompt", value: "TEXT" },
  { name: "name", long: "--name", short: "-n", value: "NAME" },
  { name: "no-session", long: "--no-session" },
  { name: "session", long: "--session", value: "REF" },
  { name: "session-id", long: "--session-id", value: "ID" },
  { name: "fork", long: "--fork", value: "REF" },
  { name: "session-dir", long: "--session-dir", value: "DIR" },
  { name: "workspace", long: "--workspace", value: "DIR" },
  { name: "models", long: "--models", value: "PATTERNS" },
  { name: "no-tools", long: "--no-tools", short: "-nt" },
  { name: "no-builtin-tools", long: "--no-builtin-tools", short: "-nbt" },
  { name: "tools", long: "--tools", short: "-t", value: "LIST" },
  { name: "exclude-tools", long: "--exclude-tools", short: "-xt", value: "LIST" },
  { name: "thinking", long: "--thinking", value: "LEVEL", values: CLI_THINKING_VALUES },
  { name: "print", long: "--print", short: "-p", value: "MESSAGE", optionalValue: true },
  { name: "export", long: "--export", value: "SESSION.jsonl" },
  { name: "redact", long: "--redact" },
  { name: "no-browser", long: "--no-browser" },
  { name: "max-steps", long: "--max-steps", value: "NUMBER" },
  { name: "max-output-tokens", long: "--max-output-tokens", value: "NUMBER" },
  { name: "extension", long: "--extension", short: "-e", value: "PATH" },
  { name: "no-extensions", long: "--no-extensions", short: "-ne" },
  { name: "skill", long: "--skill", value: "PATH" },
  { name: "prompt-template", long: "--prompt-template", value: "PATH" },
  { name: "theme", long: "--theme", value: "PATH" },
  { name: "no-skills", long: "--no-skills", short: "-ns" },
  { name: "no-prompt-templates", long: "--no-prompt-templates", short: "-np" },
  { name: "no-themes", long: "--no-themes" },
  { name: "no-context-files", long: "--no-context-files", short: "-nc" },
  { name: "list-models", long: "--list-models", value: "TEXT", optionalValue: true },
  { name: "verbose", long: "--verbose" },
  { name: "approve", long: "--approve", short: "-a" },
  { name: "no-approve", long: "--no-approve", short: "-na" },
  { name: "offline", long: "--offline" },
] as const satisfies readonly CliOptionMetadata[];

export type AgentCliOptionName = (typeof AGENT_CLI_OPTIONS)[number]["name"];

export const MANAGEMENT_CLI_OPTIONS = [
  { name: "json", long: "--json" },
  { name: "yes", long: "--yes", short: "-y" },
  { name: "all", long: "--all" },
  { name: "local", long: "--local", short: "-l" },
  { name: "no-extensions", long: "--no-extensions", short: "-ne" },
  { name: "approve", long: "--approve", short: "-a" },
  { name: "no-approve", long: "--no-approve", short: "-na" },
  { name: "allow-scripts", long: "--allow-scripts" },
  { name: "offline", long: "--offline" },
  { name: "scope", long: "--scope", value: "SCOPE", values: ["user", "project"] },
  { name: "workspace", long: "--workspace", value: "DIR" },
  { name: "extension", long: "--extension", short: "-e", value: "PATH" },
  { name: "session-dir", long: "--session-dir", value: "DIR" },
  { name: "host", long: "--host", value: "HOST", values: ["127.0.0.1", "localhost", "::1"] },
  { name: "port", long: "--port", value: "PORT" },
] as const satisfies readonly CliOptionMetadata[];

export type ManagementCliOptionName = (typeof MANAGEMENT_CLI_OPTIONS)[number]["name"];

export interface ManagementCliCommandMetadata {
  name: string;
  options: readonly ManagementCliOptionName[];
  subcommands?: readonly string[];
  argumentValues?: readonly string[];
}

export const MANAGEMENT_CLI_COMMANDS = [
  {
    name: "config",
    options: ["json", "local", "scope", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"],
    subcommands: ["path", "edit", "validate"],
  },
  { name: "diagnostics", options: ["workspace"] },
  {
    name: "extensions",
    options: ["json", "local", "scope", "allow-scripts", "all", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"],
    subcommands: ["list", "doctor", "commands", "prompts", "show", "author", "install", "remove", "uninstall", "update", "packages"],
  },
  { name: "logs", options: ["json"] },
  { name: "stats", options: ["json"] },
  {
    name: "packages",
    options: ["json", "all", "allow-scripts", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"],
    subcommands: ["check", "reconcile", "update"],
  },
  {
    name: "sessions",
    options: ["json", "all", "workspace", "session-dir"],
    subcommands: ["doctor"],
  },
  { name: "install", options: ["json", "local", "scope", "allow-scripts", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"] },
  { name: "remove", options: ["json", "local", "scope", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"] },
  { name: "uninstall", options: ["yes"] },
  { name: "update", options: ["json", "local", "scope", "allow-scripts", "all", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"] },
  { name: "list", options: ["json", "local", "scope", "workspace", "approve", "no-approve", "offline", "no-extensions", "extension"] },
  { name: "self-install", options: [] },
  { name: "self-update", options: [] },
  { name: "self-uninstall", options: ["yes"] },
  { name: "serve", options: ["workspace", "session-dir", "host", "port", "approve", "no-approve", "offline", "no-extensions", "extension"] },
  { name: "completions", options: [], argumentValues: CLI_COMPLETION_SHELLS },
] as const satisfies readonly ManagementCliCommandMetadata[];

export const EXTENSION_AUTHOR_COMMANDS = ["validate", "inspect", "pack", "smoke", "refresh", "report", "index"] as const;
export const AGENT_CLI_COMMANDS = ["chat", "run"] as const;
export const CLI_HELP_TOPICS = [
  ...MANAGEMENT_CLI_COMMANDS.map((command) => command.name),
  ...AGENT_CLI_COMMANDS,
  "rpc",
] as const;
