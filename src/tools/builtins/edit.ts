import { constants } from "node:fs";
import { access } from "node:fs/promises";

import type { JsonValue } from "../../core/json.js";
import { withFileMutation } from "../file-mutation-queue.js";
import { inputObject, stringInput } from "../input.js";
import {
  atomicWritePath,
  displayToolPath,
  MAX_TOOL_SOURCE_FILE_BYTES,
  readFileSnapshotBounded,
  resolveToolPath,
  snapshotRegularFile,
} from "../paths.js";
import { assertSchema } from "../schema.js";
import type { HarnessTool, ResourceClaim, ToolContext, ToolResult } from "../types.js";

const schema: Record<string, JsonValue> = {
  type: "object",
  additionalProperties: false,
  required: ["path", "edits"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    edits: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["oldText", "newText"],
        properties: {
          oldText: { type: "string" },
          newText: { type: "string" },
        },
      },
    },
  },
};

interface Replacement {
  oldText: string;
  newText: string;
  index: number;
}

interface TextRange {
  start: number;
  end: number;
}

interface PlannedRange extends TextRange {
  editIndex: number;
  replacement: string;
  mode: "exact" | "normalized";
}

interface NormalizedText {
  text: string;
  starts: number[];
  ends: number[];
}

function normalizeScalar(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u201b]/gu, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/gu, '"')
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, " ");
}

function normalizeNeedle(value: string): string {
  return normalizeScalar(value.replace(/\r\n?|\n/gu, "\n"))
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

function normalizedText(value: string): NormalizedText {
  const pieces: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let lineStart = 0;
  const append = (text: string, start: number, end: number): void => {
    pieces.push(text);
    for (let index = 0; index < text.length; index += 1) {
      starts.push(start);
      ends.push(end);
    }
  };
  const trimEnd = (): void => {
    while (pieces.length > lineStart && /[ \t]/u.test(pieces.at(-1) ?? "")) {
      const removed = pieces.pop()!;
      starts.length -= removed.length;
      ends.length -= removed.length;
    }
  };
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const part of graphemes.segment(value)) {
    const start = part.index;
    const end = start + part.segment.length;
    if (part.segment === "\n" || part.segment === "\r" || part.segment === "\r\n") {
      trimEnd();
      append("\n", start, end);
      lineStart = pieces.length;
    } else {
      append(normalizeScalar(part.segment), start, end);
    }
  }
  trimEnd();
  return { text: pieces.join(""), starts, ends };
}

function ranges(value: string, needle: string): TextRange[] {
  const found: TextRange[] = [];
  let cursor = 0;
  while (cursor <= value.length - needle.length) {
    const start = value.indexOf(needle, cursor);
    if (start < 0) break;
    found.push({ start, end: start + needle.length });
    cursor = start + Math.max(1, needle.length);
  }
  return found;
}

function normalizedRanges(value: NormalizedText, needle: string): TextRange[] {
  const selected = normalizeNeedle(needle);
  if (selected === "") return [];
  const result: TextRange[] = [];
  const seen = new Set<string>();
  for (const match of ranges(value.text, selected)) {
    const start = value.starts[match.start];
    const end = value.ends[match.end - 1];
    if (start === undefined || end === undefined) continue;
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ start, end });
  }
  return result;
}

function lineEnding(value: string): "\r\n" | "\n" {
  const firstLf = value.indexOf("\n");
  return firstLf > 0 && value[firstLf - 1] === "\r" ? "\r\n" : "\n";
}

function restoreLineEndings(value: string, ending: "\r\n" | "\n"): string {
  const normalized = value.replace(/\r\n?|\n/gu, "\n");
  return ending === "\r\n" ? normalized.replaceAll("\n", "\r\n") : normalized;
}

function replaceRanges(value: string, plan: readonly PlannedRange[]): string {
  let output = value;
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    const range = plan[index]!;
    output = `${output.slice(0, range.start)}${range.replacement}${output.slice(range.end)}`;
  }
  return output;
}

function displayDiff(path: string, original: string, plan: readonly PlannedRange[]): string {
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const range of plan) {
    const oldText = original.slice(range.start, range.end).replace(/\r\n?/gu, "\n");
    const newText = range.replacement.replace(/\r\n?/gu, "\n");
    lines.push(
      `@@ edit ${range.editIndex + 1} @@`,
      ...oldText.split("\n").filter((line, index, all) => line !== "" || index < all.length - 1).map((line) => `-${line}`),
      ...newText.split("\n").filter((line, index, all) => line !== "" || index < all.length - 1).map((line) => `+${line}`),
    );
  }
  const value = lines.join("\n");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= 8 * 1024) return value;
  let end = 8 * 1024 - Buffer.byteLength("\n... diff truncated", "utf8");
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n... diff truncated`;
}

function requestedEdits(input: JsonValue): Replacement[] {
  const object = inputObject(input);
  if (!Array.isArray(object.edits) || object.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  const edits = object.edits;
  return edits.map((entry, index) => {
    const edit = inputObject(entry);
    const oldText = stringInput(edit, "oldText");
    if (oldText === "") throw new Error(edits.length === 1 ? `oldText must not be empty in ${String(object.path)}.` : `edits[${index}].oldText must not be empty in ${String(object.path)}.`);
    return { oldText, newText: stringInput(edit, "newText"), index };
  });
}

function prepareEditInput(input: JsonValue): JsonValue {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const object = { ...input } as Record<string, JsonValue>;
  if (typeof object.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(object.edits);
      if (Array.isArray(parsed)) object.edits = parsed as JsonValue;
    } catch {
      // Validation will provide the model-facing error.
    }
  }
  if (typeof object.oldText !== "string" || typeof object.newText !== "string") return object;
  const edits = Array.isArray(object.edits) ? [...object.edits] : [];
  edits.push({ oldText: object.oldText, newText: object.newText });
  delete object.oldText;
  delete object.newText;
  return { ...object, edits } as JsonValue;
}

export class EditTool implements HarnessTool {
  readonly definition = {
    name: "edit",
    description: "Edit one file with unique, exact text replacements. Multiple non-overlapping edits are matched against the original file. Paths may be relative or absolute.",
    promptSnippet: "Apply one or more unique exact replacements to an existing file",
    promptGuidelines: [
      "Read enough surrounding context before edit, and make each oldText uniquely identify the intended existing text.",
    ],
    inputSchema: schema,
  };

  readonly prepareInput = (input: JsonValue): JsonValue => prepareEditInput(input);

  validate(input: JsonValue): void {
    assertSchema(schema, input);
    requestedEdits(input);
  }

  resources(input: JsonValue, context: ToolContext): ResourceClaim[] {
    const requested = stringInput(inputObject(input), "path");
    return [{ kind: "file", key: resolveToolPath(requested, context.workspace.root), mode: "write" }];
  }

  async execute(input: JsonValue, context: ToolContext): Promise<ToolResult> {
    this.validate(input);
    const object = inputObject(input);
    const requested = stringInput(object, "path");
    const edits = requestedEdits(input);
    const absolute = resolveToolPath(requested, context.workspace.root);
    const shownPath = displayToolPath(absolute, context.workspace.root);

    return await withFileMutation(absolute, async () => {
      const throwIfAborted = (): void => context.signal.throwIfAborted();
      throwIfAborted();
      try {
        await access(absolute, constants.R_OK | constants.W_OK);
      } catch (error) {
        const detail = error instanceof Error && "code" in error ? `Error code: ${String(error.code)}` : String(error);
        throw new Error(`Could not edit file: ${requested}. ${detail}.`);
      }
      throwIfAborted();
      const initial = await snapshotRegularFile(absolute);
      if (initial.snapshot.size > MAX_TOOL_SOURCE_FILE_BYTES) {
        throw new Error(`Could not edit ${requested}: file exceeds the ${MAX_TOOL_SOURCE_FILE_BYTES}-byte safety limit.`);
      }
      const loaded = await readFileSnapshotBounded(absolute, MAX_TOOL_SOURCE_FILE_BYTES);
      if (loaded.truncated) {
        throw new Error(`Could not edit ${requested}: file exceeds the ${MAX_TOOL_SOURCE_FILE_BYTES}-byte safety limit.`);
      }
      const raw = loaded.data.toString("utf8");
      throwIfAborted();
      const bom = raw.startsWith("\ufeff") ? "\ufeff" : "";
      const content = bom === "" ? raw : raw.slice(1);
      const ending = lineEnding(content);
      const normalized = normalizedText(content);
      const plan: PlannedRange[] = [];

      for (const edit of edits) {
        const exact = ranges(content, edit.oldText);
        const mode = exact.length > 0 ? "exact" as const : "normalized" as const;
        const matches = exact.length > 0 ? exact : normalizedRanges(normalized, edit.oldText);
        if (matches.length === 0) {
          throw new Error(edits.length === 1
            ? `Could not find the exact text in ${requested}. The old text must match exactly including all whitespace and newlines.`
            : `Could not find edits[${edit.index}] in ${requested}. The oldText must match exactly including all whitespace and newlines.`);
        }
        if (matches.length > 1) {
          throw new Error(edits.length === 1
            ? `Found ${matches.length} occurrences of the text in ${requested}. The text must be unique. Please provide more context to make it unique.`
            : `Found ${matches.length} occurrences of edits[${edit.index}] in ${requested}. Each oldText must be unique. Please provide more context to make it unique.`);
        }
        plan.push({
          ...matches[0]!,
          editIndex: edit.index,
          mode,
          replacement: restoreLineEndings(edit.newText, ending),
        });
      }

      plan.sort((left, right) => left.start - right.start);
      for (let index = 1; index < plan.length; index += 1) {
        const previous = plan[index - 1]!;
        const current = plan[index]!;
        if (previous.end > current.start) {
          throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${requested}. Merge them into one edit or target disjoint regions.`);
        }
      }
      const updated = replaceRanges(content, plan);
      if (updated === content) {
        throw new Error(edits.length === 1
          ? `No changes made to ${requested}. The replacement produced identical content.`
          : `No changes made to ${requested}. The replacements produced identical content.`);
      }
      const diff = displayDiff(requested, content, plan);
      await atomicWritePath(loaded.path, Buffer.from(`${bom}${updated}`, "utf8"), { expected: loaded.snapshot });
      return {
        content: `Successfully replaced ${edits.length} block(s) in ${requested}.`,
        isError: false,
        metadata: {
          path: shownPath,
          replacements: edits.length,
          firstChangedLine: content.slice(0, plan[0]!.start).split(/\r\n?|\n/gu).length,
          diff,
          patch: diff,
          modes: plan.map((entry) => entry.mode),
        },
      };
    });
  }
}
