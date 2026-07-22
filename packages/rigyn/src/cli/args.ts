export type Mode = "text" | "json" | "rpc";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CliDiagnostic {
  type: "warning" | "error";
  message: string;
}

/** Arguments accepted by the coding-agent entry point. */
export interface Args {
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  thinking?: ThinkingLevel;
  continue?: boolean;
  resume?: boolean;
  all?: boolean;
  help?: boolean;
  version?: boolean;
  mode?: Mode;
  name?: string;
  noSession?: boolean;
  session?: string;
  sessionId?: string;
  fork?: string;
  sessionDir?: string;
  workspace?: string;
  models?: string[];
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean;
  noBuiltinTools?: boolean;
  extensions?: string[];
  noExtensions?: boolean;
  print?: boolean;
  export?: string;
  redact?: boolean;
  noBrowser?: boolean;
  maxSteps?: number;
  maxOutputTokens?: number;
  noSkills?: boolean;
  skills?: string[];
  promptTemplates?: string[];
  noPromptTemplates?: boolean;
  themes?: string[];
  noThemes?: boolean;
  noContextFiles?: boolean;
  listModels?: string | true;
  offline?: boolean;
  verbose?: boolean;
  projectTrustOverride?: boolean;
  messages: string[];
  fileArgs: string[];
  unknownFlags: Map<string, boolean | string>;
  diagnostics: CliDiagnostic[];
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isValidThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

function nextValue(values: readonly string[], index: number): string | undefined {
  return index + 1 < values.length ? values[index + 1] : undefined;
}

function requiredOptionValue(
  values: readonly string[],
  index: number,
  flag: string,
  diagnostics: CliDiagnostic[],
): string | undefined {
  const value = nextValue(values, index);
  if (value === undefined || value.startsWith("-")) {
    diagnostics.push({ type: "error", message: `${flag} requires a value` });
    return undefined;
  }
  return value;
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function positiveInteger(value: string | undefined, flag: string, diagnostics: CliDiagnostic[]): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    diagnostics.push({ type: "error", message: `${flag} must be a positive integer` });
    return undefined;
  }
  return Number(value);
}

/** Parse the agent invocation without interpreting extension-owned long flags. */
export function parseArgs(values: readonly string[]): Args {
  const result: Args = {
    messages: [],
    fileArgs: [],
    unknownFlags: new Map(),
    diagnostics: [],
  };

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!;
    const next = nextValue(values, index);
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--version" || argument === "-v") result.version = true;
    else if (argument === "--mode") {
      const value = requiredOptionValue(values, index, "--mode", result.diagnostics);
      if (value !== undefined) {
        if (value === "text" || value === "json" || value === "rpc") result.mode = value;
        else result.diagnostics.push({ type: "error", message: `Invalid mode "${value}". Valid values: text, json, rpc` });
        index += 1;
      }
    } else if (argument === "--continue" || argument === "-c") result.continue = true;
    else if (argument === "--resume" || argument === "-r") result.resume = true;
    else if (argument === "--all") result.all = true;
    else if (argument === "--provider") {
      const value = requiredOptionValue(values, index, "--provider", result.diagnostics);
      if (value !== undefined) { result.provider = value; index += 1; }
    }
    else if (argument === "--model") {
      const value = requiredOptionValue(values, index, "--model", result.diagnostics);
      if (value !== undefined) { result.model = value; index += 1; }
    }
    else if (argument === "--api-key") {
      const value = requiredOptionValue(values, index, "--api-key", result.diagnostics);
      if (value !== undefined) { result.apiKey = value; index += 1; }
    }
    else if (argument === "--system-prompt") {
      const value = requiredOptionValue(values, index, "--system-prompt", result.diagnostics);
      if (value !== undefined) { result.systemPrompt = value; index += 1; }
    }
    else if (argument === "--append-system-prompt") {
      const value = requiredOptionValue(values, index, "--append-system-prompt", result.diagnostics);
      if (value !== undefined) { (result.appendSystemPrompt ??= []).push(value); index += 1; }
    } else if (argument === "--name" || argument === "-n") {
      const value = requiredOptionValue(values, index, "--name", result.diagnostics);
      if (value !== undefined) { result.name = value; index += 1; }
    } else if (argument === "--no-session") result.noSession = true;
    else if (argument === "--session") {
      const value = requiredOptionValue(values, index, "--session", result.diagnostics);
      if (value !== undefined) { result.session = value; index += 1; }
    }
    else if (argument === "--session-id") {
      const value = requiredOptionValue(values, index, "--session-id", result.diagnostics);
      if (value !== undefined) { result.sessionId = value; index += 1; }
    }
    else if (argument === "--fork") {
      const value = requiredOptionValue(values, index, "--fork", result.diagnostics);
      if (value !== undefined) { result.fork = value; index += 1; }
    }
    else if (argument === "--session-dir") {
      const value = requiredOptionValue(values, index, "--session-dir", result.diagnostics);
      if (value !== undefined) { result.sessionDir = value; index += 1; }
    }
    else if (argument === "--workspace") {
      const value = requiredOptionValue(values, index, "--workspace", result.diagnostics);
      if (value !== undefined) { result.workspace = value; index += 1; }
    }
    else if (argument === "--models") {
      const value = requiredOptionValue(values, index, "--models", result.diagnostics);
      if (value !== undefined) { result.models = value.split(",").map((item) => item.trim()); index += 1; }
    }
    else if (argument === "--no-tools" || argument === "-nt") result.noTools = true;
    else if (argument === "--no-builtin-tools" || argument === "-nbt") result.noBuiltinTools = true;
    else if (argument === "--tools" || argument === "-t") {
      const value = requiredOptionValue(values, index, "--tools", result.diagnostics);
      if (value !== undefined) { result.tools = splitList(value); index += 1; }
    }
    else if (argument === "--exclude-tools" || argument === "-xt") {
      const value = requiredOptionValue(values, index, "--exclude-tools", result.diagnostics);
      if (value !== undefined) { result.excludeTools = splitList(value); index += 1; }
    }
    else if (argument === "--thinking") {
      const value = requiredOptionValue(values, index, "--thinking", result.diagnostics);
      if (value !== undefined) {
        if (isValidThinkingLevel(value)) result.thinking = value;
        else result.diagnostics.push({
          type: "warning",
          message: `Invalid thinking level "${value}". Valid values: ${THINKING_LEVELS.join(", ")}`,
        });
        index += 1;
      }
    } else if (argument === "--print" || argument === "-p") {
      result.print = true;
      if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
        result.messages.push(next);
        index += 1;
      }
    } else if (argument === "--export") {
      if (next === undefined || next.startsWith("-")) {
        result.diagnostics.push({ type: "error", message: "--export requires a session path" });
      } else {
        result.export = next;
        index += 1;
      }
    }
    else if (argument === "--redact") result.redact = true;
    else if (argument === "--no-browser") result.noBrowser = true;
    else if (argument === "--max-steps") {
      const value = next?.startsWith("-") === true ? undefined : next;
      const parsed = positiveInteger(value, "--max-steps", result.diagnostics);
      if (parsed !== undefined) result.maxSteps = parsed;
      if (value !== undefined) index += 1;
    } else if (argument === "--max-output-tokens") {
      const value = next?.startsWith("-") === true ? undefined : next;
      const parsed = positiveInteger(value, "--max-output-tokens", result.diagnostics);
      if (parsed !== undefined) result.maxOutputTokens = parsed;
      if (value !== undefined) index += 1;
    }
    else if (argument === "--extension" || argument === "-e") {
      const value = requiredOptionValue(values, index, "--extension", result.diagnostics);
      if (value !== undefined) { (result.extensions ??= []).push(value); index += 1; }
    } else if (argument === "--no-extensions" || argument === "-ne") result.noExtensions = true;
    else if (argument === "--skill") {
      const value = requiredOptionValue(values, index, "--skill", result.diagnostics);
      if (value !== undefined) { (result.skills ??= []).push(value); index += 1; }
    }
    else if (argument === "--prompt-template") {
      const value = requiredOptionValue(values, index, "--prompt-template", result.diagnostics);
      if (value !== undefined) { (result.promptTemplates ??= []).push(value); index += 1; }
    }
    else if (argument === "--theme") {
      const value = requiredOptionValue(values, index, "--theme", result.diagnostics);
      if (value !== undefined) { (result.themes ??= []).push(value); index += 1; }
    }
    else if (argument === "--no-skills" || argument === "-ns") result.noSkills = true;
    else if (argument === "--no-prompt-templates" || argument === "-np") result.noPromptTemplates = true;
    else if (argument === "--no-themes") result.noThemes = true;
    else if (argument === "--no-context-files" || argument === "-nc") result.noContextFiles = true;
    else if (argument === "--list-models") {
      if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
        result.listModels = next;
        index += 1;
      } else result.listModels = true;
    } else if (argument === "--verbose") result.verbose = true;
    else if (argument === "--approve" || argument === "-a") {
      if (result.projectTrustOverride === false) result.diagnostics.push({ type: "error", message: "--approve and --no-approve are mutually exclusive" });
      else result.projectTrustOverride = true;
    }
    else if (argument === "--no-approve" || argument === "-na") {
      if (result.projectTrustOverride === true) result.diagnostics.push({ type: "error", message: "--approve and --no-approve are mutually exclusive" });
      else result.projectTrustOverride = false;
    }
    else if (argument === "--offline") result.offline = true;
    else if (argument.startsWith("@")) result.fileArgs.push(argument.slice(1));
    else if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      if (equals >= 0) result.unknownFlags.set(argument.slice(2, equals), argument.slice(equals + 1));
      else if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
        result.unknownFlags.set(argument.slice(2), next);
        index += 1;
      } else result.unknownFlags.set(argument.slice(2), true);
    } else if (argument.startsWith("-")) {
      result.diagnostics.push({ type: "error", message: `Unknown option: ${argument}` });
    } else result.messages.push(argument);
  }

  return result;
}
