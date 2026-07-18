import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { createId } from "../core/ids.js";
import type { EventEnvelope } from "../core/events.js";
import type { CanonicalMessage, ContentBlock } from "../core/types.js";
import { SessionStore } from "../storage/store.js";
import {
  SESSION_EXPORT_FORMAT,
  SESSION_EXPORT_SCHEMA_VERSION,
  sessionExportEvent,
} from "../storage/session-export.js";
import type { ThreadRecord } from "../storage/types.js";

const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_IMPORT_LINES = 100_000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_HTML_EXPORT_BYTES = 64 * 1024 * 1024;
const USER_SHELL_MESSAGE_PREFIX = "[User shell command]\n";
const SHARE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactObjectKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function boundedPositiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

export interface ImportThreadResult {
  thread: ThreadRecord;
  events: number;
  artifacts: number;
  omittedEmptyBranches: string[];
}

export function importThreadJsonl(
  store: SessionStore,
  source: string,
  options: { workspaceRoot: string },
): ImportThreadResult {
  if (Buffer.byteLength(source) > MAX_IMPORT_BYTES) throw new Error(`Session import exceeds ${MAX_IMPORT_BYTES} bytes`);
  const lines = source.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0 || lines.length > MAX_IMPORT_LINES) throw new Error("Session import has an invalid line count");
  const records = lines.map((line, index) => {
    if (Buffer.byteLength(line) > MAX_ARTIFACT_BYTES * 2) throw new Error(`Session import line ${index + 1} is too large`);
    try {
      return object(JSON.parse(line) as unknown, `line ${index + 1}`);
    } catch (error) {
      throw new Error(`Session import line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const formatLines = records.filter((record) => record.type === "format");
  if (formatLines.length > 1) throw new Error("Session import contains more than one format record");
  const formatLine = formatLines[0];
  let exportSchemaVersion = 1;
  if (formatLine !== undefined) {
    if (records[0] !== formatLine) throw new Error("Session import format record must be first");
    const format = object(formatLine.value, "format.value");
    if (
      format.format !== SESSION_EXPORT_FORMAT
      || !Number.isSafeInteger(format.schemaVersion)
      || (format.schemaVersion !== 1 && format.schemaVersion !== SESSION_EXPORT_SCHEMA_VERSION)
    ) {
      throw new Error(`Unsupported session export format or schema version: ${String(format.format)}@${String(format.schemaVersion)}`);
    }
    exportSchemaVersion = format.schemaVersion as number;
  }
  const threadLines = records.filter((record) => record.type === "thread");
  if (threadLines.length > 1) throw new Error("Session import contains more than one thread record");
  const threadLine = threadLines[0];
  if (threadLine === undefined) throw new Error("Session import is missing its thread record");
  const originalThread = object(threadLine.value, "thread.value");
  exactObjectKeys(originalThread, [
    "threadId", "name", "defaultBranch", "createdAt", "updatedAt", "parentThreadId", "parentRunId",
    "workspaceRoot", "branches",
  ], "thread.value");
  const defaultBranch = string(originalThread.defaultBranch, "thread.defaultBranch");
  const name = typeof originalThread.name === "string" && originalThread.name.trim() !== ""
    ? originalThread.name
    : undefined;
  const imported = store.createThread({
    ...(name === undefined ? {} : { name }),
    defaultBranch,
    workspaceRoot: options.workspaceRoot,
  });
  const eventIds = new Map<string, string>();
  const eventBranches = new Map<string, string>();
  const eventParents = new Map<string, string | undefined>();
  const branchHeads = new Map<string, string | undefined>([[defaultBranch, undefined]]);
  const branchIncarnations = new Map<string, number>([[defaultBranch, 1]]);
  const runIds = new Map<string, string>();
  let eventCount = 0;
  let artifactCount = 0;
  const omittedEmptyBranches: string[] = [];

  const eventIsAncestor = (headEventId: string | undefined, candidateEventId: string): boolean => {
    let cursor = headEventId;
    while (cursor !== undefined) {
      if (cursor === candidateEventId) return true;
      cursor = eventParents.get(cursor);
    }
    return false;
  };

  const forkImportedBranch = (branch: string, originalParent: string | undefined): void => {
    if (originalParent === undefined) {
      const sourceBranch = branchHeads.keys().next().value as string | undefined;
      if (sourceBranch === undefined) throw new Error(`Imported branch ${branch} has no available fork source`);
      store.forkBranch({ threadId: imported.threadId, fromBranch: sourceBranch, newBranch: branch, atEventId: null });
      return;
    }
    const mappedParent = eventIds.get(originalParent);
    if (mappedParent === undefined) throw new Error(`Imported branch ${branch} has an unknown fork parent`);
    const preferred = eventBranches.get(originalParent);
    const candidates = preferred === undefined
      ? [...branchHeads.keys()]
      : [preferred, ...branchHeads.keys()].filter((value, index, values) => values.indexOf(value) === index);
    const sourceBranch = candidates.find((candidate) => (
      candidate !== branch
      && branchHeads.has(candidate)
      && eventIsAncestor(branchHeads.get(candidate), originalParent)
    ));
    if (sourceBranch === undefined) throw new Error(`Imported branch ${branch} has an unreachable fork parent`);
    store.forkBranch({
      threadId: imported.threadId,
      fromBranch: sourceBranch,
      newBranch: branch,
      atEventId: mappedParent,
    });
  };

  try {
    for (const [index, record] of records.entries()) {
      if (record.type !== "event") continue;
      const envelope = object(record.value, `line ${index + 1}.value`) as unknown as EventEnvelope;
      const originalEventId = string(envelope.eventId, `line ${index + 1}.eventId`);
      if (eventIds.has(originalEventId)) throw new Error(`Duplicate imported event ID: ${originalEventId}`);
      const branch = exportSchemaVersion >= 2
        ? string(record.branch, `line ${index + 1}.branch`)
        : typeof record.branch === "string" ? record.branch : defaultBranch;
      const branchIncarnation = exportSchemaVersion >= 2
        ? boundedPositiveInteger(record.branchIncarnation, `line ${index + 1}.branchIncarnation`, MAX_IMPORT_LINES)
        : 1;
      const originalParent = envelope.parentEventId === undefined
        ? undefined
        : string(envelope.parentEventId, `line ${index + 1}.parentEventId`);
      const currentIncarnation = branchIncarnations.get(branch);
      if (currentIncarnation === undefined) {
        if (branchIncarnation !== 1) throw new Error(`Imported branch ${branch} begins at invalid incarnation ${branchIncarnation}`);
        forkImportedBranch(branch, originalParent);
        branchIncarnations.set(branch, branchIncarnation);
        branchHeads.set(branch, originalParent);
      } else if (branchIncarnation !== currentIncarnation) {
        if (branch === defaultBranch) throw new Error(`Imported default branch ${branch} cannot change incarnation`);
        if (branchIncarnation !== currentIncarnation + 1) {
          throw new Error(`Imported branch ${branch} has a non-consecutive incarnation`);
        }
        store.deleteBranch(imported.threadId, branch);
        branchHeads.delete(branch);
        branchIncarnations.delete(branch);
        forkImportedBranch(branch, originalParent);
        branchIncarnations.set(branch, branchIncarnation);
        branchHeads.set(branch, originalParent);
      }
      if (branchHeads.get(branch) !== originalParent) throw new Error(`Imported branch ${branch} has a non-linear event chain`);
      if (envelope.event === null || typeof envelope.event !== "object") throw new Error(`Imported event ${originalEventId} is malformed`);
      let event = sessionExportEvent(envelope.event);
      if (event.type === "entry_label_changed") {
        const targetEventId = eventIds.get(event.targetEventId);
        if (targetEventId === undefined) throw new Error(`Imported label references an unknown event: ${event.targetEventId}`);
        event = { ...event, targetEventId };
      } else if (event.type === "branch_summary_created") {
        const sourceEventIds = event.sourceEventIds.flatMap((eventId) => {
          const mapped = eventIds.get(eventId);
          return mapped === undefined ? [] : [mapped];
        });
        event = sourceEventIds.length === event.sourceEventIds.length && branchHeads.has(event.sourceBranch)
          ? { ...event, sourceEventIds }
          : { type: "message_appended", message: event.summary };
      }
      let runId: string | undefined;
      if (envelope.runId !== undefined) {
        const originalRunId = string(envelope.runId, `line ${index + 1}.runId`);
        runId = runIds.get(originalRunId);
        if (event.type === "run_started") {
          if (runId !== undefined) throw new Error(`Imported run starts more than once: ${originalRunId}`);
          runId = createId("run");
          runIds.set(originalRunId, runId);
          store.startRun({
            threadId: imported.threadId,
            branch,
            runId,
            provider: event.provider,
            model: event.model,
          });
        } else if (runId === undefined) {
          throw new Error(`Imported event references a run before run_started: ${originalRunId}`);
        }
      } else if (event.type === "run_started") {
        throw new Error("Imported run_started event has no run ID");
      }
      const mappedEventId = createId("event");
      store.appendEvent({
        threadId: imported.threadId,
        branch,
        ...(runId === undefined ? {} : { runId }),
        event,
        eventId: mappedEventId,
        timestamp: envelope.timestamp,
        expectedHead: originalParent === undefined ? null : eventIds.get(originalParent) ?? null,
      });
      eventIds.set(originalEventId, mappedEventId);
      eventBranches.set(originalEventId, branch);
      eventParents.set(originalEventId, originalParent);
      branchHeads.set(branch, originalEventId);
      eventCount += 1;
    }

    const exportedBranches = Array.isArray(originalThread.branches) ? originalThread.branches : [];
    const desiredBranches = new Set<string>([defaultBranch]);
    const seenExportedBranches = new Set<string>();
    for (const value of exportedBranches) {
      const branch = object(value, "thread.branch");
      const branchName = string(branch.name, "thread.branch.name");
      if (seenExportedBranches.has(branchName)) throw new Error(`Imported thread contains duplicate branch ${branchName}`);
      seenExportedBranches.add(branchName);
      desiredBranches.add(branchName);
      const originalHead = typeof branch.headEventId === "string" ? branch.headEventId : undefined;
      if (originalHead !== undefined && !eventIds.has(originalHead)) {
        throw new Error(`Imported branch ${branchName} references an unknown head`);
      }
      if (branchHeads.has(branchName) && branchHeads.get(branchName) === originalHead) continue;
      if (branchName === defaultBranch) throw new Error(`Imported default branch ${branchName} has an inconsistent head`);
      const nextIncarnation = (branchIncarnations.get(branchName) ?? 0) + 1;
      if (branchHeads.has(branchName)) {
        store.deleteBranch(imported.threadId, branchName);
        branchHeads.delete(branchName);
        branchIncarnations.delete(branchName);
      }
      forkImportedBranch(branchName, originalHead);
      branchHeads.set(branchName, originalHead);
      branchIncarnations.set(branchName, nextIncarnation);
    }
    for (const branchName of [...branchHeads.keys()]) {
      if (desiredBranches.has(branchName)) continue;
      store.deleteBranch(imported.threadId, branchName);
      branchHeads.delete(branchName);
      branchIncarnations.delete(branchName);
    }

    for (const [index, record] of records.entries()) {
      if (record.type !== "artifact") continue;
      const value = object(record.value, `line ${index + 1}.value`);
      const encoded = string(value.content, `line ${index + 1}.content`);
      const content = Buffer.from(encoded, "base64");
      if (content.length > MAX_ARTIFACT_BYTES || content.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) {
        throw new Error(`Imported artifact on line ${index + 1} is invalid or too large`);
      }
      if (value.byteLength !== content.length) throw new Error(`Imported artifact on line ${index + 1} has an invalid byte length`);
      const digest = createHash("sha256").update(content).digest("hex");
      if (value.sha256 !== digest) throw new Error(`Imported artifact on line ${index + 1} has an invalid digest`);
      const mappedRun = typeof value.runId === "string" ? runIds.get(value.runId) : undefined;
      const mappedEvent = typeof value.eventId === "string" ? eventIds.get(value.eventId) : undefined;
      if (typeof value.runId === "string" && mappedRun === undefined) {
        throw new Error(`Imported artifact on line ${index + 1} references an unknown run`);
      }
      if (typeof value.eventId === "string" && mappedEvent === undefined) {
        throw new Error(`Imported artifact on line ${index + 1} references an unknown event`);
      }
      store.putArtifact({
        threadId: imported.threadId,
        content,
        mediaType: string(value.mediaType, `line ${index + 1}.mediaType`),
        ...(mappedRun === undefined ? {} : { runId: mappedRun }),
        ...(mappedEvent === undefined ? {} : { eventId: mappedEvent }),
      });
      artifactCount += 1;
    }
    return {
      thread: store.getThread(imported.threadId),
      events: eventCount,
      artifacts: artifactCount,
      omittedEmptyBranches,
    };
  } catch (error) {
    store.deleteThread(imported.threadId);
    throw error;
  }
}

function blockText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "tool_call") return `Tool call \`${block.name}\` (${block.callId})\n\n\`\`\`json\n${JSON.stringify(block.arguments, null, 2)}\n\`\`\``;
  if (block.type === "tool_result") {
    const images = (block.images?.length ?? 0) === 0
      ? ""
      : `\n\n${block.images!.map((image) => `[Image: ${image.mediaType}]`).join("\n")}`;
    return `Tool result \`${block.name}\` (${block.callId})${block.isError ? " — error" : ""}\n\n\`\`\`text\n${block.content}\n\`\`\`${images}`;
  }
  if (block.type === "image") return `[Image: ${block.mediaType}]`;
  return `[Provider-specific ${block.mediaType} content from ${block.provider}]`;
}

function messageMarkdown(message: CanonicalMessage): string {
  const title = message.role[0]?.toUpperCase() + message.role.slice(1);
  return `## ${title}\n\n${message.displayText ?? message.content.map(blockText).join("\n\n")}`;
}

export function exportThreadMarkdown(store: SessionStore, threadId: string, branch?: string): string {
  const thread = store.getThread(threadId);
  const selected = branch ?? thread.defaultBranch;
  const messages = store.listEvents(threadId, selected).flatMap((envelope) =>
    envelope.event.type === "message_appended"
      ? [messageMarkdown(envelope.event.message)]
      : envelope.event.type === "branch_summary_created"
        ? [messageMarkdown(envelope.event.summary)]
        : envelope.event.type === "extension_message" && envelope.event.transcript !== false
          ? [`## Extension · ${envelope.event.extensionId}/${envelope.event.kind}\n\n${envelope.event.transcript.text}`]
        : []);
  return `# ${thread.name ?? "Rigyn session"}\n\n- Session: \`${thread.threadId}\`\n- Branch: \`${selected}\`\n- Exported: ${new Date().toISOString()}\n\n${messages.join("\n\n")}\n`;
}

function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function blockHtml(block: ContentBlock): string {
  if (block.type === "text") return `<pre class="content">${html(block.text)}</pre>`;
  if (block.type === "tool_call") {
    return `<details class="tool"><summary>Tool call <code>${html(block.name)}</code></summary><pre>${html(JSON.stringify(block.arguments, null, 2))}</pre></details>`;
  }
  if (block.type === "tool_result") {
    const images = block.images?.map((image) => `<li>${html(image.mediaType)} image</li>`).join("") ?? "";
    return `<details class="tool${block.isError ? " error" : ""}" open><summary>Tool result <code>${html(block.name)}</code>${block.isError ? " — error" : ""}</summary><pre>${html(block.content)}</pre>${images === "" ? "" : `<ul>${images}</ul>`}</details>`;
  }
  if (block.type === "image") return `<p class="image">Image attachment: ${html(block.mediaType)}</p>`;
  return `<p class="opaque">Provider-specific ${html(block.mediaType)} content from ${html(block.provider)}</p>`;
}

function messageHtml(message: CanonicalMessage, timestamp: string): string {
  const visible = message.displayText === undefined
    ? message.content.map(blockHtml).join("")
    : `<pre class="content">${html(message.displayText)}</pre>`;
  const purpose = message.purpose === undefined ? "" : `<span class="purpose">${html(message.purpose)}</span>`;
  return `<article class="message ${html(message.role)}"><header><strong>${html(message.role)}</strong>${purpose}<time>${html(timestamp)}</time></header>${visible}</article>`;
}

function boundedExport(parts: readonly string[], label: string): string {
  const value = parts.join("");
  if (Buffer.byteLength(value, "utf8") > MAX_HTML_EXPORT_BYTES) {
    throw new Error(`${label} export exceeds the ${MAX_HTML_EXPORT_BYTES} byte limit`);
  }
  return value;
}

function boundedHtml(parts: readonly string[]): string {
  return boundedExport(parts, "HTML");
}

export function exportThreadHtml(store: SessionStore, threadId: string, branch?: string): string {
  const thread = store.getThread(threadId);
  const selected = branch ?? thread.defaultBranch;
  if (!thread.branches.some((entry) => entry.name === selected)) throw new Error(`Unknown branch: ${selected}`);
  const allRuns = store.listRuns(threadId);
  const branches = thread.branches.map((entry, index) => {
    const events = store.listEvents(threadId, entry.name);
    const messages = events.flatMap((envelope) => {
      const message = envelope.event.type === "message_appended"
        ? envelope.event.message
        : envelope.event.type === "branch_summary_created"
          ? envelope.event.summary
          : undefined;
      if (message !== undefined) return [messageHtml(message, envelope.timestamp)];
      if (envelope.event.type !== "extension_message" || envelope.event.transcript === false) return [];
      return [
        `<article class="message extension"><header><strong>${html(`${envelope.event.extensionId}/${envelope.event.kind}`)}</strong><time>${html(envelope.timestamp)}</time></header><pre class="content">${html(envelope.event.transcript.text)}</pre></article>`,
      ];
    });
    const runs = allRuns.filter((run) => run.branch === entry.name);
    const selectedClass = entry.name === selected ? " selected" : "";
    return {
      button: `<button type="button" class="branch-button${selectedClass}" data-target="branch-${index}"><span>${html(entry.name)}</span><small>${messages.length} messages · ${runs.length} runs</small></button>`,
      panel: `<section class="branch${selectedClass}" id="branch-${index}"${entry.name === selected ? "" : " hidden"}><h2>${html(entry.name)}</h2><p class="branch-meta">Updated ${html(entry.updatedAt)} · ${messages.length} messages · ${runs.length} runs</p>${messages.join("") || '<p class="empty">No messages on this branch.</p>'}</section>`,
    };
  });
  const title = html(thread.name ?? "Rigyn session");
  return boundedHtml([
    "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:\">",
    `<title>${title}</title><style>`,
    ":root{color-scheme:dark light;font:15px/1.5 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#101114;color:#e8e8e8}header.page{padding:1.25rem 1.5rem;border-bottom:1px solid #35373d}h1{margin:0 0 .35rem;font-size:1.35rem}.meta,.branch-meta{color:#a8adb7}.controls{display:flex;gap:.75rem;margin-top:1rem}.controls input{min-width:12rem;max-width:36rem;width:100%;padding:.55rem .7rem;background:#191b20;color:inherit;border:1px solid #454851;border-radius:.4rem}.layout{display:grid;grid-template-columns:minmax(13rem,19rem) minmax(0,1fr);min-height:calc(100vh - 8rem)}nav{padding:1rem;border-right:1px solid #35373d}.branch-button{display:block;width:100%;text-align:left;padding:.65rem;margin:0 0 .4rem;border:1px solid transparent;border-radius:.4rem;background:transparent;color:inherit}.branch-button:hover,.branch-button.selected{background:#20232a;border-color:#484c57}.branch-button span,.branch-button small{display:block;overflow-wrap:anywhere}.branch-button small{color:#a8adb7}main{min-width:0;max-width:72rem;width:100%;padding:1rem 1.5rem}.branch>h2{margin-top:0}.message{margin:0 0 1rem;border:1px solid #363942;border-left-width:.3rem;border-radius:.45rem;background:#17191e;overflow:hidden}.message.user{border-left-color:#66aaff}.message.assistant{border-left-color:#7bd88f}.message.tool{border-left-color:#d7a65a}.message>header{display:flex;gap:.6rem;align-items:baseline;padding:.55rem .8rem;background:#20232a}.message time{margin-left:auto;color:#949aa6;font-size:.8rem}.purpose{color:#b5a0ff;font-size:.8rem}.content,.tool pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:.8rem;font:13px/1.55 ui-monospace,monospace}.tool{margin:.7rem;border:1px solid #3d4655;border-radius:.35rem}.tool summary{cursor:pointer;padding:.45rem .6rem;color:#9bc8ff}.tool.error{border-color:#9c4d55}.tool.error summary{color:#ff9da7}.image,.opaque,.empty{padding:0 .8rem;color:#a8adb7}@media(max-width:700px){.layout{display:block}nav{border-right:0;border-bottom:1px solid #35373d}.message>header{flex-wrap:wrap}.message time{width:100%;margin-left:0}}@media print{body{background:#fff;color:#000}nav,.controls{display:none}.layout{display:block}main{max-width:none}.branch{display:block!important}.message{break-inside:avoid;background:#fff}}",
    "</style></head><body>",
    `<header class="page"><h1>${title}</h1><div class="meta">Session <code>${html(thread.threadId)}</code> · ${thread.branches.length} branch${thread.branches.length === 1 ? "" : "es"} · exported ${html(new Date().toISOString())}</div><div class="controls"><label>Filter messages <input id="search" type="search" maxlength="512" autocomplete="off"></label></div></header>`,
    `<div class="layout"><nav aria-label="Branches">${branches.map((entry) => entry.button).join("")}</nav><main>${branches.map((entry) => entry.panel).join("")}</main></div>`,
    "<script>(()=>{const buttons=[...document.querySelectorAll('.branch-button')];const panels=[...document.querySelectorAll('.branch')];for(const button of buttons)button.addEventListener('click',()=>{for(const item of buttons)item.classList.toggle('selected',item===button);for(const panel of panels){const selected=panel.id===button.dataset.target;panel.hidden=!selected;panel.classList.toggle('selected',selected)}});const search=document.getElementById('search');search.addEventListener('input',()=>{const query=search.value.toLocaleLowerCase();for(const message of document.querySelectorAll('.message'))message.hidden=query!==''&&!message.textContent.toLocaleLowerCase().includes(query)})})();</script>",
    "</body></html>\n",
  ]);
}

const REDACTED_SHARE_NOTICE = "Redacted share copy; review before publishing.";

export interface RedactedSessionExportOptions {
  branch?: string;
  workspaceRoot?: string;
  homeRoot?: string;
}

interface RedactedSessionEntry {
  role: "user" | "assistant" | "extension";
  text: string;
}

function redactedRootReplacements(
  thread: ThreadRecord,
  options: RedactedSessionExportOptions,
): Array<{ root: string; replacement: string }> {
  const roots: Array<[string | undefined, string]> = [
    [options.workspaceRoot ?? thread.workspaceRoot, "[WORKSPACE]"],
    [options.homeRoot ?? homedir(), "[HOME]"],
  ];
  const replacements: Array<{ root: string; replacement: string }> = [];
  const seen = new Set<string>();
  for (const [root, replacement] of roots) {
    if (root === undefined || root.length <= 1) continue;
    for (const variant of [root, root.replaceAll("\\", "/"), root.replaceAll("/", "\\")]) {
      if (variant.length <= 1 || seen.has(variant)) continue;
      seen.add(variant);
      replacements.push({ root: variant, replacement });
    }
  }
  return replacements.sort((left, right) => right.root.length - left.root.length);
}

function redactedSessionEntries(
  store: SessionStore,
  threadId: string,
  options: RedactedSessionExportOptions,
): RedactedSessionEntry[] {
  const thread = store.getThread(threadId);
  const selected = options.branch ?? thread.defaultBranch;
  const roots = redactedRootReplacements(thread, options);
  const redact = (value: string): string => {
    let result = value.replace(/\r\n?/gu, "\n").replace(SHARE_CONTROL_CHARACTERS, "");
    for (const replacement of roots) result = result.replaceAll(replacement.root, replacement.replacement);
    return defaultSecretRedactor.redact(result);
  };
  const visibleMessage = (message: CanonicalMessage): RedactedSessionEntry | undefined => {
    if (message.role !== "user" && message.role !== "assistant") return undefined;
    const text = message.displayText
      ?? message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
    if (message.role === "user" && (
      text.startsWith(USER_SHELL_MESSAGE_PREFIX)
      || text.startsWith(USER_SHELL_MESSAGE_PREFIX.replace("\n", "\r\n"))
    )) return undefined;
    const redacted = redact(text);
    if (redacted.trim() === "") return undefined;
    return { role: message.role, text: redacted };
  };

  return store.listEvents(threadId, selected).flatMap((envelope) => {
    const message = envelope.event.type === "message_appended"
      ? envelope.event.message
      : envelope.event.type === "branch_summary_created"
        ? envelope.event.summary
        : undefined;
    if (message !== undefined) {
      const visible = visibleMessage(message);
      return visible === undefined ? [] : [visible];
    }
    if (envelope.event.type !== "extension_message" || envelope.event.transcript === false) return [];
    const text = redact(envelope.event.transcript.text);
    return text.trim() === "" ? [] : [{ role: "extension" as const, text }];
  });
}

export function exportThreadRedactedMarkdown(
  store: SessionStore,
  threadId: string,
  options: RedactedSessionExportOptions = {},
): string {
  const entries = redactedSessionEntries(store, threadId, options);
  const messages = entries.map((entry) => {
    const longestBacktickRun = [...entry.text.matchAll(/`+/gu)]
      .reduce((longest, match) => Math.max(longest, match[0].length), 0);
    const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
    return `## ${entry.role[0]!.toUpperCase()}${entry.role.slice(1)}\n\n${fence}\n${entry.text}\n${fence}`;
  }).join("\n\n");
  return boundedExport([
    `# Rigyn session share copy\n\n> ${REDACTED_SHARE_NOTICE}\n`,
    messages === "" ? "" : `\n${messages}\n`,
  ], "Redacted Markdown");
}

export function exportThreadRedactedHtml(
  store: SessionStore,
  threadId: string,
  options: RedactedSessionExportOptions = {},
): string {
  const entries = redactedSessionEntries(store, threadId, options);
  const messages = entries.map((entry) =>
    `<article class="message ${entry.role}"><header><strong>${entry.role}</strong></header><pre>${html(entry.text)}</pre></article>`).join("");
  return boundedHtml([
    "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
    "<title>Rigyn session share copy</title><style>",
    ":root{color-scheme:dark light;font:15px/1.5 system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#101114;color:#e8e8e8}main{max-width:72rem;margin:auto;padding:1.5rem}h1{font-size:1.35rem}.notice{padding:.75rem;border:1px solid #8c7937;border-radius:.4rem;background:#29240f;color:#f2dda0}.message{margin:1rem 0;border:1px solid #363942;border-left-width:.3rem;border-radius:.45rem;background:#17191e;overflow:hidden}.message.user{border-left-color:#66aaff}.message.assistant{border-left-color:#7bd88f}.message.extension{border-left-color:#b5a0ff}.message header{padding:.55rem .8rem;background:#20232a}.message pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:.8rem;font:13px/1.55 ui-monospace,monospace}.empty{color:#a8adb7}@media print{body{background:#fff;color:#000}.message{break-inside:avoid;background:#fff}}",
    "</style></head><body><main><h1>Rigyn session share copy</h1>",
    `<p class="notice">${html(REDACTED_SHARE_NOTICE)}</p>`,
    messages === "" ? '<p class="empty">No shareable prose on this branch.</p>' : messages,
    "</main></body></html>\n",
  ]);
}
