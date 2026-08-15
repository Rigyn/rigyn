import {
  AGENT_CLI_OPTIONS,
  CLI_MODE_VALUES,
  CLI_THINKING_VALUES,
  type CliOptionMetadata,
} from "./metadata.js";

export interface CliDiagnostic { type: "warning" | "error"; message: string }

export interface Args {
  source: string[];
  diagnostics: CliDiagnostic[];
  unknownFlags: Map<string, boolean | string>;
  messages: string[];
  positionals: string[];
  fileArgs: string[];
  extensions: string[];
  skills: string[];
  promptTemplates: string[];
  themes: string[];
  appendSystemPrompt?: string[];
  models?: string[];
  tools?: string[];
  excludeTools?: string[];
  help?: boolean;
  version?: boolean;
  mode?: "text" | "json" | "rpc";
  continue?: boolean;
  resume?: boolean;
  all?: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  name?: string;
  noSession?: boolean;
  session?: string;
  sessionId?: string;
  fork?: string;
  sessionDir?: string;
  workspace?: string;
  noTools?: boolean;
  noBuiltinTools?: boolean;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  print?: boolean;
  export?: string;
  redact?: boolean;
  noBrowser?: boolean;
  maxSteps?: number;
  maxOutputTokens?: number;
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  listModels?: true | string;
  verbose?: boolean;
  projectTrustOverride?: boolean;
  offline?: boolean;
}

const BY_TOKEN = new Map<string, CliOptionMetadata>();
for (const option of AGENT_CLI_OPTIONS as readonly CliOptionMetadata[]) {
  BY_TOKEN.set(option.long, option);
  if (option.short !== undefined) BY_TOKEN.set(option.short, option);
}

function commaList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function isOption(value: string | undefined): boolean {
  return value !== undefined && value.startsWith("-") && value !== "-";
}

function positiveInteger(value: string, option: string, diagnostics: CliDiagnostic[]): number | undefined {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    diagnostics.push({ type: "error", message: `${option} must be a positive integer` });
    return undefined;
  }
  return parsed;
}

export function parseArgs(argv: readonly string[]): Args {
  const result: Args = {
    source: [...argv],
    diagnostics: [],
    unknownFlags: new Map(),
    messages: [],
    positionals: [],
    fileArgs: [],
    extensions: [],
    skills: [],
    promptTemplates: [],
    themes: [],
  };
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") { positionalOnly = true; continue; }
    if (!positionalOnly && argument.startsWith("--") && argument.includes("=")) {
      const equal = argument.indexOf("=");
      const token = argument.slice(0, equal);
      const option = BY_TOKEN.get(token);
      const inline = argument.slice(equal + 1);
      if (option === undefined) {
        result.unknownFlags.set(token.slice(2), inline);
        continue;
      }
      apply(option, inline, result);
      continue;
    }
    if (!positionalOnly && isOption(argument)) {
      const option = BY_TOKEN.get(argument);
      if (option === undefined) {
        if (argument.startsWith("--")) {
          const next = argv[index + 1];
          if (next !== undefined && !isOption(next) && !next.startsWith("@")) {
            result.unknownFlags.set(argument.slice(2), next);
            index += 1;
          } else result.unknownFlags.set(argument.slice(2), true);
        } else result.diagnostics.push({ type: "error", message: `Unknown option: ${argument}` });
        continue;
      }
      if (option.optionalValue === true) {
        if (option.name === "list-models") {
          const next = argv[index + 1];
          if (next !== undefined && !isOption(next) && !next.startsWith("@")) {
            result.listModels = next;
            index += 1;
          } else result.listModels = true;
        } else apply(option, undefined, result);
        continue;
      }
      if (option.value !== undefined) {
        const next = argv[index + 1];
        const numeric = option.name === "max-steps" || option.name === "max-output-tokens";
        if (next === undefined || (isOption(next) && !(numeric && /^-\d/u.test(next)))) {
          const suffix = option.name === "export" ? "a session path" : "a value";
          result.diagnostics.push({ type: "error", message: `${option.long} requires ${suffix}` });
          continue;
        }
        apply(option, next, result);
        index += 1;
        continue;
      }
      apply(option, undefined, result);
      continue;
    }
    if (argument.startsWith("@") && argument.length > 1) result.fileArgs.push(argument.slice(1));
    else { result.messages.push(argument); result.positionals.push(argument); }
  }
  return result;
}

function apply(option: CliOptionMetadata, value: string | undefined, result: Args): void {
  switch (option.name) {
    case "help": result.help = true; break;
    case "version": result.version = true; break;
    case "continue": result.continue = true; break;
    case "resume": result.resume = true; break;
    case "all": result.all = true; break;
    case "no-session": result.noSession = true; break;
    case "no-tools": result.noTools = true; break;
    case "no-builtin-tools": result.noBuiltinTools = true; break;
    case "print":
      result.print = true;
      if (value !== undefined) {
        result.messages.push(value);
        result.positionals.push(value);
      }
      break;
    case "redact": result.redact = true; break;
    case "no-browser": result.noBrowser = true; break;
    case "no-extensions": result.noExtensions = true; break;
    case "no-skills": result.noSkills = true; break;
    case "no-prompt-templates": result.noPromptTemplates = true; break;
    case "no-themes": result.noThemes = true; break;
    case "no-context-files": result.noContextFiles = true; break;
    case "verbose": result.verbose = true; break;
    case "approve":
      if (result.projectTrustOverride === false) {
        result.diagnostics.push({ type: "error", message: "--approve and --no-approve are mutually exclusive" });
      }
      result.projectTrustOverride = true;
      break;
    case "no-approve":
      if (result.projectTrustOverride === true) {
        result.diagnostics.push({ type: "error", message: "--approve and --no-approve are mutually exclusive" });
      }
      result.projectTrustOverride = false;
      break;
    case "offline": result.offline = true; break;
    case "mode":
      if ((CLI_MODE_VALUES as readonly string[]).includes(value ?? "")) result.mode = value as NonNullable<Args["mode"]>;
      else result.diagnostics.push({ type: "error", message: `Invalid mode "${value}". Valid values: ${CLI_MODE_VALUES.join(", ")}` });
      break;
    case "thinking":
      if ((CLI_THINKING_VALUES as readonly string[]).includes(value ?? "")) result.thinking = value as NonNullable<Args["thinking"]>;
      else result.diagnostics.push({ type: "warning", message: `Invalid thinking level "${value}"` });
      break;
    case "models": result.models = commaList(value!); break;
    case "tools": result.tools = commaList(value!); break;
    case "exclude-tools": result.excludeTools = commaList(value!); break;
    case "extension": result.extensions.push(value!); break;
    case "skill": result.skills.push(value!); break;
    case "prompt-template": result.promptTemplates.push(value!); break;
    case "theme": result.themes.push(value!); break;
    case "append-system-prompt": (result.appendSystemPrompt ??= []).push(value!); break;
    case "max-steps": {
      const parsed = positiveInteger(value!, option.long, result.diagnostics);
      if (parsed !== undefined) result.maxSteps = parsed;
      break;
    }
    case "max-output-tokens": {
      const parsed = positiveInteger(value!, option.long, result.diagnostics);
      if (parsed !== undefined) result.maxOutputTokens = parsed;
      break;
    }
    case "list-models": result.listModels = value === undefined ? true : value; break;
    case "provider": result.provider = value!; break;
    case "model": result.model = value!; break;
    case "api-key": result.apiKey = value!; break;
    case "system-prompt": result.systemPrompt = value!; break;
    case "name": result.name = value!; break;
    case "session": result.session = value!; break;
    case "session-id": result.sessionId = value!; break;
    case "fork": result.fork = value!; break;
    case "session-dir": result.sessionDir = value!; break;
    case "workspace": result.workspace = value!; break;
    case "export": result.export = value!; break;
  }
}
