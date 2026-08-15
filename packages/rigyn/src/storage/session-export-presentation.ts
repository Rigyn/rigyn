export interface SessionExportTextPreview {
  text: string;
  totalBytes: number;
  totalLines: number;
  truncated: boolean;
}

export interface SessionExportPresentationTreeNode {
  id: string;
  children: readonly SessionExportPresentationTreeNode[];
}

export interface SessionExportPresentationTreeRow<TNode extends SessionExportPresentationTreeNode> {
  node: TNode;
  depth: number;
  connector: "" | "├─ " | "└─ ";
}

function sessionExportUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function sessionExportDecodeUtf8Edge(encoded: Uint8Array, maximumBytes: number, tail: boolean): string {
  if (maximumBytes <= 0 || encoded.length === 0) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (encoded.length <= maximumBytes) return decoder.decode(encoded);
  if (!tail) {
    let end = Math.min(maximumBytes, encoded.length);
    while (end > 0) {
      try { return decoder.decode(encoded.subarray(0, end)); }
      catch { end -= 1; }
    }
    return "";
  }
  let start = Math.max(0, encoded.length - maximumBytes);
  while (start < encoded.length) {
    try { return decoder.decode(encoded.subarray(start)); }
    catch { start += 1; }
  }
  return "";
}

function sessionExportUtf8Slice(value: string, maximumBytes: number, tail: boolean): string {
  if (maximumBytes <= 0 || value === "") return "";
  return sessionExportDecodeUtf8Edge(new TextEncoder().encode(value), maximumBytes, tail);
}

function sessionExportUtf8Prefix(value: unknown, maximumBytes: number): {
  text: string;
  bytes: number;
  truncated: boolean;
} {
  const source = String(value ?? "");
  if (maximumBytes <= 0 || source === "") return { text: "", bytes: 0, truncated: source !== "" };
  let end = Math.min(source.length, maximumBytes);
  if (end < source.length && end > 0 && source.charCodeAt(end - 1) >= 0xd800 && source.charCodeAt(end - 1) <= 0xdbff) {
    end -= 1;
  }
  const encoded = new TextEncoder().encode(source.slice(0, end));
  const text = sessionExportDecodeUtf8Edge(encoded, maximumBytes, false);
  return {
    text,
    bytes: sessionExportUtf8Bytes(text),
    truncated: end < source.length || encoded.length > maximumBytes,
  };
}

function sessionExportLineCount(value: string): number {
  if (value === "") return 0;
  let separators = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0d) {
      separators += 1;
      if (value.charCodeAt(index + 1) === 0x0a) index += 1;
    } else if (code === 0x0a) separators += 1;
  }
  const finalCode = value.charCodeAt(value.length - 1);
  return separators + (finalCode === 0x0d || finalCode === 0x0a ? 0 : 1);
}

function sessionExportMetric(value: number, singular: string): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : `${singular}s`}`;
}

function sessionExportOneLine(value: unknown, maximumCharacters = 180): string {
  const limit = Number.isFinite(maximumCharacters) ? Math.max(1, Math.floor(maximumCharacters)) : 180;
  const retained = sessionExportUtf8Prefix(value, Math.max(128, limit * 4));
  const selected = retained.text
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(selected);
  if (!retained.truncated && characters.length <= limit) return selected;
  return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export function sessionExportSearchText(values: readonly unknown[], maximumBytes = 16 * 1024): string {
  const limit = Number.isFinite(maximumBytes) ? Math.max(128, Math.floor(maximumBytes)) : 16 * 1024;
  const retained: string[] = [];
  let remaining = limit;
  for (const value of values) {
    if (remaining <= 0) break;
    const source = String(value ?? "");
    if (source === "") continue;
    if (retained.length > 0) {
      if (remaining <= 1) break;
      retained.push(" ");
      remaining -= 1;
    }
    const selected = sessionExportUtf8Prefix(source, remaining);
    if (selected.text === "") break;
    retained.push(selected.text);
    remaining -= selected.bytes;
    if (selected.truncated) break;
  }
  return sessionExportUtf8Prefix(retained.join("").toLowerCase(), limit).text;
}

function sessionExportRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sessionExportStringField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (value === undefined) return undefined;
  for (const key of keys) {
    const selected = value[key];
    if (typeof selected === "string") return selected;
  }
  return undefined;
}

function sessionExportNumberField(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const selected = value?.[key];
  return typeof selected === "number" && Number.isFinite(selected) && selected >= 0 ? selected : undefined;
}

function sessionExportMutationData(
  value: unknown,
  maximumRetainedEdits: number,
): {
  edits: Array<{ oldText: string; newText: string }>;
  editCount: number;
  oldLines: number;
  newLines: number;
  oldBytes: number;
  newBytes: number;
} {
  const input = sessionExportRecord(value);
  const result = { edits: [], editCount: 0, oldLines: 0, newLines: 0, oldBytes: 0, newBytes: 0 } as {
    edits: Array<{ oldText: string; newText: string }>;
    editCount: number;
    oldLines: number;
    newLines: number;
    oldBytes: number;
    newBytes: number;
  };
  if (input === undefined) return result;
  const oldText = sessionExportStringField(input, ["oldText", "old_string"]);
  const newText = sessionExportStringField(input, ["newText", "new_string"]);
  const candidates = oldText !== undefined && newText !== undefined
    ? [{ oldText, newText }]
    : Array.isArray(input.edits) ? input.edits : [];
  for (const candidate of candidates) {
    const edit = sessionExportRecord(candidate);
    const before = sessionExportStringField(edit, ["oldText", "old_string"]);
    const after = sessionExportStringField(edit, ["newText", "new_string"]);
    if (before === undefined || after === undefined) continue;
    result.editCount += 1;
    result.oldLines += sessionExportLineCount(before);
    result.newLines += sessionExportLineCount(after);
    result.oldBytes += sessionExportUtf8Bytes(before);
    result.newBytes += sessionExportUtf8Bytes(after);
    if (result.edits.length < maximumRetainedEdits) result.edits.push({ oldText: before, newText: after });
  }
  return result;
}

export function sessionExportBranchChildDepth(parentDepth: number, childCount: number): number {
  const current = Number.isFinite(parentDepth) ? Math.max(0, Math.floor(parentDepth)) : 0;
  return Math.min(24, current + (childCount > 1 ? 1 : 0));
}

export function sessionExportTreeRows<TNode extends SessionExportPresentationTreeNode>(
  rootValues: readonly TNode[],
  allValues: readonly TNode[],
): Array<SessionExportPresentationTreeRow<TNode>> {
  function valid(value: unknown): value is TNode {
    return value !== null
      && typeof value === "object"
      && typeof (value as { id?: unknown }).id === "string"
      && Array.isArray((value as { children?: unknown }).children);
  }
  function unique(values: readonly TNode[]): TNode[] {
    const ids = new Set<string>();
    return values.filter((value) => {
      if (!valid(value) || ids.has(value.id)) return false;
      ids.add(value.id);
      return true;
    });
  }
  const rows: Array<SessionExportPresentationTreeRow<TNode>> = [];
  const visited = new Set<string>();
  function traverse(selectedRoots: readonly TNode[]): void {
    const roots = unique(selectedRoots).filter((node) => !visited.has(node.id));
    const stack: Array<SessionExportPresentationTreeRow<TNode>> = [];
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: roots[index]!,
        depth: 0,
        connector: roots.length > 1 ? (index === roots.length - 1 ? "└─ " : "├─ ") : "",
      });
    }
    while (stack.length > 0) {
      const selected = stack.pop();
      if (selected === undefined || visited.has(selected.node.id)) continue;
      visited.add(selected.node.id);
      rows.push(selected);
      const children = unique(selected.node.children as readonly TNode[])
        .filter((child) => !visited.has(child.id));
      const childDepth = sessionExportBranchChildDepth(selected.depth, children.length);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({
          node: children[index]!,
          depth: childDepth,
          connector: children.length > 1 ? (index === children.length - 1 ? "└─ " : "├─ ") : "",
        });
      }
    }
  }
  traverse(rootValues);
  for (const node of allValues) {
    if (valid(node) && !visited.has(node.id)) traverse([node]);
  }
  return rows;
}

export function sessionExportToolCallSummary(nameValue: unknown, argumentsValue: unknown): string {
  const name = sessionExportOneLine(nameValue, 80) || "tool";
  const input = sessionExportRecord(argumentsValue);
  const path = sessionExportOneLine(
    sessionExportStringField(input, ["path", "filePath", "file_path", "file", "directory"]),
  );
  const parts = ["tool call", name];
  if (name === "write") {
    if (path !== "") parts.push(path);
    const content = sessionExportStringField(input, ["content"]);
    if (content !== undefined) {
      parts.push(sessionExportMetric(sessionExportLineCount(content), "line"));
      parts.push(sessionExportMetric(sessionExportUtf8Bytes(content), "byte"));
    }
  } else if (name === "edit") {
    if (path !== "") parts.push(path);
    const edits = sessionExportMutationData(input, 0);
    if (edits.editCount > 1) parts.push(sessionExportMetric(edits.editCount, "edit"));
    if (edits.editCount > 0) {
      parts.push(`${edits.oldLines.toLocaleString("en-US")} → ${sessionExportMetric(edits.newLines, "line")}`);
      parts.push(`${edits.oldBytes.toLocaleString("en-US")} → ${sessionExportMetric(edits.newBytes, "byte")}`);
    }
  } else if (name === "apply_patch") {
    if (path !== "") parts.push(path);
    const patch = sessionExportStringField(input, ["patch", "patchText"]);
    if (patch !== undefined) {
      parts.push(sessionExportMetric(sessionExportLineCount(patch), "line"));
      parts.push(sessionExportMetric(sessionExportUtf8Bytes(patch), "byte"));
    }
  } else if (name === "read") {
    if (path !== "") {
      const offset = sessionExportNumberField(input, "offset");
      const limit = sessionExportNumberField(input, "limit");
      const start = offset ?? 1;
      parts.push(`${path}${offset === undefined && limit === undefined ? "" : `:${start}${limit === undefined ? "" : `-${start + Math.max(0, limit - 1)}`}`}`);
    }
  } else if (name === "grep") {
    const pattern = sessionExportOneLine(sessionExportStringField(input, ["pattern", "query"]));
    if (pattern !== "") parts.push(`/${pattern}/`);
    if (path !== "") parts.push(`in ${path}`);
    const limit = sessionExportNumberField(input, "limit");
    if (limit !== undefined) parts.push(`limit ${limit.toLocaleString("en-US")}`);
  } else if (name === "find") {
    const pattern = sessionExportOneLine(sessionExportStringField(input, ["pattern"]));
    if (pattern !== "") parts.push(pattern);
    if (path !== "") parts.push(`in ${path}`);
    const limit = sessionExportNumberField(input, "limit");
    if (limit !== undefined) parts.push(`limit ${limit.toLocaleString("en-US")}`);
  } else if (name === "ls") {
    if (path !== "") parts.push(path);
    const limit = sessionExportNumberField(input, "limit");
    if (limit !== undefined) parts.push(`limit ${limit.toLocaleString("en-US")}`);
  } else if (name === "bash" || name === "shell") {
    const command = sessionExportOneLine(sessionExportStringField(input, ["command", "cmd"]), 240);
    if (command !== "") parts.push(`$ ${command}`);
    const timeout = sessionExportNumberField(input, "timeout");
    if (timeout !== undefined) parts.push(`timeout ${timeout.toLocaleString("en-US")}s`);
  }
  return parts.join(" · ");
}

export function sessionExportToolResultSummary(
  nameValue: unknown,
  isError: boolean,
  contentValue: unknown,
  statusValue?: unknown,
): string {
  const name = sessionExportOneLine(nameValue, 80) || "tool";
  const content = String(contentValue ?? "");
  const status = isError
    ? "error"
    : statusValue === "warning" || statusValue === "error" || statusValue === "success"
      ? statusValue
      : "success";
  return [
    "tool result",
    name,
    status,
    sessionExportMetric(sessionExportLineCount(content), "line"),
    sessionExportMetric(sessionExportUtf8Bytes(content), "byte"),
  ].join(" · ");
}

export function sessionExportMutationPreview(nameValue: unknown, argumentsValue: unknown): string | undefined {
  const name = String(nameValue ?? "").toLowerCase();
  const input = sessionExportRecord(argumentsValue);
  if (name === "write") return sessionExportStringField(input, ["content"]);
  if (name === "apply_patch") return sessionExportStringField(input, ["patch", "patchText"]);
  if (name !== "edit") return undefined;
  const edits = sessionExportMutationData(input, 32);
  if (edits.editCount === 0) return undefined;
  const perValueBytes = Math.max(256, Math.floor(56 * 1024 / Math.max(1, edits.edits.length * 2)));
  const selected = edits.edits.flatMap((edit, index) => [
    `--- edit ${index + 1} before`,
    sessionExportBoundedText(edit.oldText, perValueBytes, 100, 2 * 1024).text,
    `+++ edit ${index + 1} after`,
    sessionExportBoundedText(edit.newText, perValueBytes, 100, 2 * 1024).text,
  ]);
  if (edits.editCount > edits.edits.length) selected.push(`… ${edits.editCount - edits.edits.length} additional edits not shown`);
  return sessionExportBoundedText(selected.join("\n"), 64 * 1024, 400, 4 * 1024).text;
}

export function sessionExportMutationResultPreview(
  nameValue: unknown,
  isError: boolean,
  metadataValue: unknown,
): string | undefined {
  const name = String(nameValue ?? "").toLowerCase();
  if (isError || (name !== "write" && name !== "edit" && name !== "apply_patch")) return undefined;
  const metadata = sessionExportRecord(metadataValue);
  const selected = sessionExportStringField(metadata, ["diff", "patch"]);
  if (selected === undefined || selected.trim() === "") return undefined;
  return sessionExportBoundedText(selected, 64 * 1024, 400, 4 * 1024).text;
}

function sessionExportBoundLine(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  const totalBytes = encoded.length;
  if (totalBytes <= maximumBytes) return { text: value, truncated: false };
  const retainedBudget = Math.max(0, maximumBytes - 64);
  const head = sessionExportDecodeUtf8Edge(encoded, Math.floor(retainedBudget * 2 / 3), false);
  const tail = sessionExportDecodeUtf8Edge(encoded, retainedBudget - sessionExportUtf8Bytes(head), true);
  const omitted = Math.max(0, totalBytes - sessionExportUtf8Bytes(head) - sessionExportUtf8Bytes(tail));
  return { text: `${head} … ${omitted.toLocaleString("en-US")} bytes omitted from line … ${tail}`, truncated: true };
}

function sessionExportBoundBytes(value: string, maximumBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  const totalBytes = encoded.length;
  if (totalBytes <= maximumBytes) return value;
  const retainedBudget = Math.max(0, maximumBytes - 96);
  const head = sessionExportDecodeUtf8Edge(encoded, Math.floor(retainedBudget * 2 / 3), false);
  const tail = sessionExportDecodeUtf8Edge(encoded, retainedBudget - sessionExportUtf8Bytes(head), true);
  const omitted = Math.max(0, totalBytes - sessionExportUtf8Bytes(head) - sessionExportUtf8Bytes(tail));
  const selected = `${head}\n… ${omitted.toLocaleString("en-US")} preview bytes omitted …\n${tail}`;
  return sessionExportUtf8Bytes(selected) <= maximumBytes ? selected : sessionExportUtf8Slice(selected, maximumBytes, false);
}

export function sessionExportBoundedText(
  value: unknown,
  maximumBytes = 64 * 1024,
  maximumLines = 400,
  maximumLineBytes = 4 * 1024,
): SessionExportTextPreview {
  maximumBytes = Number.isFinite(maximumBytes) ? Math.max(128, Math.floor(maximumBytes)) : 64 * 1024;
  maximumLines = Number.isFinite(maximumLines) ? Math.max(1, Math.floor(maximumLines)) : 400;
  maximumLineBytes = Number.isFinite(maximumLineBytes) ? Math.max(32, Math.floor(maximumLineBytes)) : 4 * 1024;
  const source = String(value ?? "");
  const totalBytes = sessionExportUtf8Bytes(source);
  const headCount = Math.floor((maximumLines - 1) * 2 / 3);
  const tailCapacity = maximumLines - headCount;
  const head: Array<[number, number]> = [];
  const tail = new Array<[number, number]>(tailCapacity);
  let tailCount = 0;
  let tailNext = 0;
  let totalLines = 0;
  const retain = (start: number, end: number): void => {
    if (totalLines < headCount) head.push([start, end]);
    else if (tailCapacity > 0) {
      tail[tailNext] = [start, end];
      tailNext = (tailNext + 1) % tailCapacity;
      tailCount = Math.min(tailCapacity, tailCount + 1);
    }
    totalLines += 1;
  };
  let lineStart = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code !== 0x0d && code !== 0x0a) continue;
    retain(lineStart, index);
    if (code === 0x0d && source.charCodeAt(index + 1) === 0x0a) index += 1;
    lineStart = index + 1;
  }
  const endsWithLineBreak = source.length > 0 && lineStart === source.length;
  if (lineStart < source.length) retain(lineStart, source.length);
  const orderedTail = tailCount < tailCapacity
    ? tail.slice(0, tailCount)
    : [...tail.slice(tailNext), ...tail.slice(0, tailNext)];
  let positions: Array<[number, number]>;
  let truncated = false;
  let omittedLines = 0;
  if (totalLines > maximumLines) {
    const tailCount = Math.max(0, maximumLines - headCount - 1);
    positions = [...head, ...(tailCount === 0 ? [] : orderedTail.slice(-tailCount))];
    omittedLines = totalLines - positions.length;
    truncated = true;
  } else positions = [...head, ...orderedTail];
  const boundedLines = positions.map(([start, end]) => {
    const line = source.slice(start, end);
    const bounded = sessionExportBoundLine(line, maximumLineBytes);
    if (bounded.truncated) truncated = true;
    return bounded.text;
  });
  if (omittedLines > 0) boundedLines.splice(head.length, 0, `… ${omittedLines.toLocaleString("en-US")} lines omitted …`);
  let selected = boundedLines.join("\n");
  if (!truncated && endsWithLineBreak) selected += "\n";
  if (sessionExportUtf8Bytes(selected) > maximumBytes) {
    selected = sessionExportBoundBytes(selected, maximumBytes);
    truncated = true;
  }
  return { text: selected, totalBytes, totalLines, truncated };
}

export function sessionExportBoundedJson(
  value: unknown,
  maximumBytes = 64 * 1024,
  maximumNodes = 2_048,
  maximumDepth = 16,
  maximumStringBytes = 8 * 1024,
): string {
  maximumNodes = Number.isFinite(maximumNodes) ? Math.max(1, Math.floor(maximumNodes)) : 2_048;
  maximumDepth = Number.isFinite(maximumDepth) ? Math.max(1, Math.floor(maximumDepth)) : 16;
  maximumStringBytes = Number.isFinite(maximumStringBytes) ? Math.max(128, Math.floor(maximumStringBytes)) : 8 * 1024;
  let nodes = 0;
  const seen = new Set<object>();
  function project(selected: unknown, depth: number): unknown {
    if (nodes >= maximumNodes) return "… node limit reached";
    nodes += 1;
    if (typeof selected === "string") {
      return sessionExportBoundedText(selected, maximumStringBytes, 100, 2 * 1024).text;
    }
    if (selected === null || typeof selected !== "object") return selected;
    if (seen.has(selected)) return "… circular value omitted";
    if (depth >= maximumDepth) return "… depth limit reached";
    seen.add(selected);
    if (Array.isArray(selected)) {
      const output: unknown[] = [];
      for (let index = 0; index < selected.length; index += 1) {
        if (nodes >= maximumNodes) {
          output.push(`… ${(selected.length - index).toLocaleString("en-US")} remaining values omitted`);
          break;
        }
        output.push(project(selected[index], depth + 1));
      }
      seen.delete(selected);
      return output;
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key in selected) {
      if (!Object.prototype.hasOwnProperty.call(selected, key)) continue;
      if (nodes >= maximumNodes) {
        output["…"] = "remaining properties omitted";
        break;
      }
      output[key] = project((selected as Record<string, unknown>)[key], depth + 1);
    }
    seen.delete(selected);
    return output;
  }
  let serialized: string;
  try { serialized = JSON.stringify(project(value, 0), null, 2); }
  catch { serialized = String(value ?? ""); }
  return sessionExportBoundedText(serialized, maximumBytes, 400, 4 * 1024).text;
}

/** Exact browser-compatible helper definitions embedded into the standalone viewer. */
export const SESSION_EXPORT_PRESENTATION_SOURCE = [
  // tsx/esbuild preserves nested function names with this local helper; tsc output simply leaves it unused.
  "function __name(target) { return target; }",
  sessionExportUtf8Bytes,
  sessionExportDecodeUtf8Edge,
  sessionExportUtf8Slice,
  sessionExportUtf8Prefix,
  sessionExportLineCount,
  sessionExportMetric,
  sessionExportOneLine,
  sessionExportSearchText,
  sessionExportRecord,
  sessionExportStringField,
  sessionExportNumberField,
  sessionExportMutationData,
  sessionExportBranchChildDepth,
  sessionExportTreeRows,
  sessionExportToolCallSummary,
  sessionExportToolResultSummary,
  sessionExportMutationPreview,
  sessionExportMutationResultPreview,
  sessionExportBoundLine,
  sessionExportBoundBytes,
  sessionExportBoundedText,
  sessionExportBoundedJson,
].map((definition) => definition.toString()).join("\n");
