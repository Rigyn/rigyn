import { writeMachineOutput } from "../interfaces/output-guard.js";
import {
  AGENT_CLI_COMMANDS,
  AGENT_CLI_OPTIONS,
  CLI_COMPLETION_SHELLS,
  CLI_HELP_TOPICS,
  EXTENSION_AUTHOR_COMMANDS,
  MANAGEMENT_CLI_COMMANDS,
  MANAGEMENT_CLI_OPTIONS,
  type CliOptionMetadata,
  type ManagementCliCommandMetadata,
} from "./metadata.js";
import type { ManagementArguments } from "./management-args.js";

export type CompletionShell = (typeof CLI_COMPLETION_SHELLS)[number];

const HELP_TOKENS = ["--help", "-h"] as const;
const agentOptions: readonly CliOptionMetadata[] = AGENT_CLI_OPTIONS;
const managementOptionMetadata: readonly CliOptionMetadata[] = MANAGEMENT_CLI_OPTIONS;
const managementCommands: readonly ManagementCliCommandMetadata[] = MANAGEMENT_CLI_COMMANDS;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function optionTokens(options: readonly CliOptionMetadata[]): string[] {
  return options.flatMap((option) => option.short === undefined
    ? [option.long]
    : [option.long, option.short]);
}

function managementOptions(commandName: string): CliOptionMetadata[] {
  const command = managementCommands.find((candidate) => candidate.name === commandName);
  if (command === undefined) return [];
  const names: ReadonlySet<string> = new Set(command.options);
  return managementOptionMetadata.filter((option) => names.has(option.name));
}

function commandSuggestions(commandName: string): string[] {
  if (commandName === "help") return [...CLI_HELP_TOPICS];
  if ((AGENT_CLI_COMMANDS as readonly string[]).includes(commandName)) return optionTokens(AGENT_CLI_OPTIONS);
  const command = managementCommands.find((candidate) => candidate.name === commandName);
  if (command === undefined) return optionTokens(AGENT_CLI_OPTIONS);
  return [
    ...(command.subcommands ?? command.argumentValues ?? []),
    ...optionTokens(managementOptions(commandName)),
    ...HELP_TOKENS,
  ];
}

function topLevelSuggestions(): string[] {
  return [
    "help",
    ...AGENT_CLI_COMMANDS,
    ...MANAGEMENT_CLI_COMMANDS.map((command) => command.name),
    ...optionTokens(AGENT_CLI_OPTIONS),
  ];
}

function fixedValueOptions(): CliOptionMetadata[] {
  const byLong = new Map<string, CliOptionMetadata>();
  for (const option of [...agentOptions, ...managementOptionMetadata]) {
    if (option.values !== undefined) byLong.set(option.long, option);
  }
  return [...byLong.values()];
}

function managementCommandsForOption(optionName: string): string[] {
  return managementCommands
    .filter((command) => command.options.some((name) => name === optionName))
    .map((command) => command.name);
}

function freeValueTokens(): string[] {
  return [...new Set([...agentOptions, ...managementOptionMetadata]
    .filter((option) => option.value !== undefined && option.values === undefined && option.optionalValue !== true)
    .flatMap((option) => option.short === undefined ? [option.long] : [option.long, option.short]))];
}

function bashWords(values: readonly string[]): string {
  return shellQuote(values.join(" "));
}

function renderBashCompletion(): string {
  const lines = [
    "# bash completion for rigyn",
    "_rigyn() {",
    "  local cur prev command value",
    "  COMPREPLY=()",
    "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    "  prev=\"${COMP_WORDS[COMP_CWORD-1]-}\"",
    "  command=\"${COMP_WORDS[1]-}\"",
    "",
  ];
  for (const option of managementOptionMetadata.filter((candidate) => candidate.values !== undefined)) {
    const commands = managementCommandsForOption(option.name).map(shellQuote).join("|");
    lines.push(
      `  if [[ \"$cur\" == ${shellQuote(`${option.long}=`)}* ]]; then`,
      "    case \"$command\" in",
      `      ${commands})`,
      `        value=\"${"${cur#"}${option.long}=${"}"}\"`,
      `        COMPREPLY=( $(compgen -W ${bashWords(option.values ?? [])} -- \"$value\") )`,
      `        COMPREPLY=( \"${"${COMPREPLY[@]/#/"}${option.long}=${"}"}\" )`,
      "        return",
      "        ;;",
      "    esac",
      "  fi",
    );
  }
  lines.push(
    "  case \"$prev\" in",
  );
  for (const option of fixedValueOptions()) {
    const patterns = [option.long, ...(option.short === undefined ? [] : [option.short])]
      .map(shellQuote).join("|");
    lines.push(
      `    ${patterns})`,
      `      COMPREPLY=( $(compgen -W ${bashWords(option.values ?? [])} -- \"$cur\") )`,
      "      return",
      "      ;;",
    );
  }
  lines.push(
    `    ${freeValueTokens().map(shellQuote).join("|")})`,
    "      return",
    "      ;;",
    "  esac",
    "",
    "  case \"$command\" in",
    `    ${shellQuote("extensions")})`,
    "      if [[ \"${COMP_WORDS[2]-}\" == \"author\" ]]; then",
    `        COMPREPLY=( $(compgen -W ${bashWords([...EXTENSION_AUTHOR_COMMANDS, ...optionTokens(managementOptions("extensions")), ...HELP_TOKENS])} -- \"$cur\") )`,
    "      else",
    `        COMPREPLY=( $(compgen -W ${bashWords(commandSuggestions("extensions"))} -- \"$cur\") )`,
    "      fi",
    "      ;;",
  );
  for (const command of ["help", ...AGENT_CLI_COMMANDS, ...MANAGEMENT_CLI_COMMANDS.map((entry) => entry.name)]) {
    if (command === "extensions") continue;
    lines.push(
      `    ${shellQuote(command)})`,
      `      COMPREPLY=( $(compgen -W ${bashWords(commandSuggestions(command))} -- \"$cur\") )`,
      "      ;;",
    );
  }
  lines.push(
    "    *)",
    `      COMPREPLY=( $(compgen -W ${bashWords(topLevelSuggestions())} -- \"$cur\") )`,
    "      ;;",
    "  esac",
    "}",
    "complete -o bashdefault -o default -F _rigyn rigyn",
    "",
  );
  return lines.join("\n");
}

function zshArray(values: readonly string[]): string {
  return values.map(shellQuote).join(" ");
}

function renderZshCompletion(): string {
  const lines = [
    "#compdef rigyn",
    "# zsh completion for rigyn",
    "_rigyn() {",
    "  local -a values",
  ];
  for (const option of managementOptionMetadata.filter((candidate) => candidate.values !== undefined)) {
    const commands = managementCommandsForOption(option.name).map(shellQuote).join("|");
    lines.push(
      `  if [[ \"$words[CURRENT]\" == ${shellQuote(`${option.long}=`)}* ]]; then`,
      "    case \"$words[2]\" in",
      `      ${commands})`,
      `        values=(${zshArray((option.values ?? []).map((value) => `${option.long}=${value}`))})`,
      "        compadd -a values",
      "        return",
      "        ;;",
      "    esac",
      "  fi",
    );
  }
  lines.push(
    "  case \"${words[CURRENT-1]}\" in",
  );
  for (const option of fixedValueOptions()) {
    const patterns = [option.long, ...(option.short === undefined ? [] : [option.short])]
      .map(shellQuote).join("|");
    lines.push(
      `    ${patterns})`,
      `      values=(${zshArray(option.values ?? [])})`,
      "      compadd -a values",
      "      return",
      "      ;;",
    );
  }
  lines.push(
    `    ${freeValueTokens().map(shellQuote).join("|")})`,
    "      _message 'rigyn value'",
    "      return",
    "      ;;",
    "  esac",
    "",
    "  case \"$words[2]\" in",
    `    ${shellQuote("extensions")})`,
    "      if [[ \"$words[3]\" == \"author\" ]]; then",
    `        values=(${zshArray([...EXTENSION_AUTHOR_COMMANDS, ...optionTokens(managementOptions("extensions")), ...HELP_TOKENS])})`,
    "      else",
    `        values=(${zshArray(commandSuggestions("extensions"))})`,
    "      fi",
    "      ;;",
  );
  for (const command of ["help", ...AGENT_CLI_COMMANDS, ...MANAGEMENT_CLI_COMMANDS.map((entry) => entry.name)]) {
    if (command === "extensions") continue;
    lines.push(
      `    ${shellQuote(command)})`,
      `      values=(${zshArray(commandSuggestions(command))})`,
      "      ;;",
    );
  }
  lines.push(
    "    *)",
    `      values=(${zshArray(topLevelSuggestions())})`,
    "      ;;",
    "  esac",
    "  compadd -a values",
    "}",
    "compdef _rigyn rigyn",
    "",
  );
  return lines.join("\n");
}

function fishCondition(value: string): string {
  return `-n ${shellQuote(value)}`;
}

function fishOption(option: CliOptionMetadata, condition: string): string {
  const parts = ["complete", "-c", "rigyn", fishCondition(condition), "-l", option.long.slice(2)];
  if (option.short !== undefined) {
    parts.push(option.short.length === 2 ? "-s" : "-o", option.short.slice(1));
  }
  if (option.value !== undefined && option.optionalValue !== true) parts.push("-r");
  if (option.values !== undefined) parts.push("-f", "-a", shellQuote(option.values.join(" ")));
  return parts.join(" ");
}

function renderFishCompletion(): string {
  const topCommands = ["help", ...AGENT_CLI_COMMANDS, ...MANAGEMENT_CLI_COMMANDS.map((command) => command.name)];
  const managementAndHelp = ["help", ...MANAGEMENT_CLI_COMMANDS.map((command) => command.name)];
  const agentCondition = `not __fish_seen_subcommand_from ${managementAndHelp.join(" ")}`;
  const lines = [
    "# fish completion for rigyn",
    `complete -c rigyn -f ${fishCondition(`not __fish_seen_subcommand_from ${topCommands.join(" ")}`)} -a ${shellQuote(topCommands.join(" "))}`,
    "complete -c rigyn -s h -l help",
  ];
  for (const option of AGENT_CLI_OPTIONS) {
    if (option.name === "help") continue;
    lines.push(fishOption(option, agentCondition));
  }
  for (const command of managementCommands) {
    const condition = `__fish_seen_subcommand_from ${command.name}`;
    for (const option of managementOptions(command.name)) lines.push(fishOption(option, condition));
    const suggestions = command.subcommands ?? command.argumentValues;
    if (suggestions !== undefined) {
      lines.push(`complete -c rigyn -f ${fishCondition(condition)} -a ${shellQuote(suggestions.join(" "))}`);
    }
  }
  lines.push(
    `complete -c rigyn -f ${fishCondition("__fish_seen_subcommand_from extensions; and __fish_seen_subcommand_from author")} -a ${shellQuote(EXTENSION_AUTHOR_COMMANDS.join(" "))}`,
    "",
  );
  return lines.join("\n");
}

/** Render a static shell completion script from the CLI's parser metadata. */
export function renderShellCompletion(shell: CompletionShell): string {
  if (shell === "bash") return renderBashCompletion();
  if (shell === "zsh") return renderZshCompletion();
  return renderFishCompletion();
}

/** Write a requested completion script without loading the agent runtime. */
export function runCompletionsCommand(argumentsValue: ManagementArguments): void {
  const [shell, ...extra] = argumentsValue.positionals;
  if (shell === undefined || extra.length > 0) {
    throw new Error("completions requires exactly one shell: bash, zsh, or fish");
  }
  if (!(CLI_COMPLETION_SHELLS as readonly string[]).includes(shell)) {
    throw new Error(`Unsupported completion shell: ${shell}. Expected bash, zsh, or fish`);
  }
  writeMachineOutput(renderShellCompletion(shell as CompletionShell));
}
