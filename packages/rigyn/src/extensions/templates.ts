import type {
  ExtensionPromptTemplate,
  ExtensionSlashCommand,
} from "./types.js";

const MAX_TEMPLATE_INPUT_BYTES = 64 * 1024;
const MAX_TEMPLATE_RENDER_BYTES = 1024 * 1024;
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/gu;
const ARGUMENT_PLACEHOLDER = /\{\{(?:input|args)\}\}|\$\{(?:[0-9]+|ARGUMENTS|@):-[^}]*\}|\$\{@:[0-9]+(?::[0-9]+)?\}|\$ARGUMENTS|\$@|\$[0-9]+/gu;

export function validateTemplatePlaceholders(template: string, allowed: ReadonlySet<string>, label: string): void {
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name === undefined || !allowed.has(name)) throw new Error(`${label} contains unsupported placeholder ${match[0]}`);
  }
  const withoutKnownPlaceholders = template.replace(PLACEHOLDER, "");
  if (withoutKnownPlaceholders.includes("{{") || withoutKnownPlaceholders.includes("}}")) {
    throw new Error(`${label} contains a malformed placeholder`);
  }
}

function boundedInput(input: string): string {
  if (Buffer.byteLength(input) > MAX_TEMPLATE_INPUT_BYTES) {
    throw new RangeError(`Template input exceeds ${MAX_TEMPLATE_INPUT_BYTES} bytes`);
  }
  return input;
}

function templateArguments(input: string): string[] {
  const values: string[] = [];
  let value = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of input) {
    if (escaped) {
      value += character;
      escaped = false;
      started = true;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else value += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        values.push(value);
        value = "";
        started = false;
        if (values.length > 256) throw new RangeError("Template input contains more than 256 arguments");
      }
    } else {
      value += character;
      started = true;
    }
  }
  if (escaped || quote !== undefined) throw new Error("Template arguments contain an unterminated quote or escape");
  if (started) values.push(value);
  if (values.length > 256) throw new RangeError("Template input contains more than 256 arguments");
  return values;
}

function render(template: string, placeholder: "{{input}}" | "{{args}}", input: string): string {
  const original = boundedInput(input);
  const args = templateArguments(original);
  const all = args.join(" ");
  const replacement = (token: string): string => {
    if (token === "{{input}}" || token === "{{args}}") return token === placeholder ? original : token;
    if (token === "$@" || token === "$ARGUMENTS") return all;
    const fallback = /^\$\{([0-9]+|ARGUMENTS|@):-([^}]*)\}$/u.exec(token);
    if (fallback !== null) {
      const target = fallback[1];
      if (target === "ARGUMENTS" || target === "@") return all || fallback[2] || "";
      return args[Number(target) - 1] || fallback[2] || "";
    }
    const slice = /^\$\{@:([0-9]+)(?::([0-9]+))?\}$/u.exec(token);
    if (slice !== null) {
      const requestedStart = Number(slice[1]);
      const start = requestedStart === 0 ? 0 : requestedStart - 1;
      const length = slice[2] === undefined ? undefined : Number(slice[2]);
      return args.slice(start, length === undefined ? undefined : start + length).join(" ");
    }
    const position = /^\$([0-9]+)$/u.exec(token);
    return position === null ? token : args[Number(position[1]) - 1] ?? "";
  };
  const parts: string[] = [];
  let bytes = 0;
  let offset = 0;
  for (const match of template.matchAll(ARGUMENT_PLACEHOLDER)) {
    const index = match.index;
    const before = template.slice(offset, index);
    const value = replacement(match[0]);
    bytes += Buffer.byteLength(before) + Buffer.byteLength(value);
    if (bytes > MAX_TEMPLATE_RENDER_BYTES) throw new RangeError(`Rendered template exceeds ${MAX_TEMPLATE_RENDER_BYTES} bytes`);
    parts.push(before, value);
    offset = index + match[0].length;
  }
  const tail = template.slice(offset);
  bytes += Buffer.byteLength(tail);
  if (bytes > MAX_TEMPLATE_RENDER_BYTES) throw new RangeError(`Rendered template exceeds ${MAX_TEMPLATE_RENDER_BYTES} bytes`);
  parts.push(tail);
  return parts.join("");
}

export function renderExtensionPrompt(prompt: ExtensionPromptTemplate, input = ""): string {
  return render(prompt.template, "{{input}}", input);
}

export function renderExtensionCommand(command: ExtensionSlashCommand, args = ""): string {
  return render(command.template, "{{args}}", args);
}
