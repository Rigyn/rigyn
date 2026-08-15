import { spawn } from "node:child_process";
import { closeSync, writeFileSync } from "node:fs";

const mode = process.env.RIGYN_RPC_FIXTURE_MODE ?? "audit";
const send = (value) => writeFileSync(1, `${JSON.stringify(value)}\n`);
const entry = (id, parentId) => ({
  type: "thinking_level_change",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  thinkingLevel: "off",
});
const node = (id, parentId, children = []) => ({ entry: entry(id, parentId), children });
const model = {
  id: "fixture-model",
  name: "Fixture model",
  provider: "fixture",
  api: "openai-responses",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

if (mode === "child-tree") {
  const marker = process.env.RIGYN_RPC_GRANDCHILD_MARKER;
  if (marker === undefined) throw new Error("grandchild marker is required");
  const source = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
  spawn(process.execPath, ["--input-type=commonjs", "--eval", source], {
    stdio: "ignore",
    windowsHide: true,
  });
}

const relaySource = String.raw`
const { createReadStream, writeFileSync } = require("node:fs");
let done = false;
process.once("disconnect", () => { if (!done) process.kill(process.pid, "SIGKILL"); });
(async () => {
  for await (const chunk of createReadStream("", { fd: 0 })) writeFileSync(1, chunk);
  done = true;
  if (process.connected) process.disconnect();
})();
`;
const relay = spawn(process.execPath, ["--input-type=commonjs", "--eval", relaySource], {
  stdio: [0, "pipe", "inherit", "ipc"],
  windowsHide: true,
});
const input = relay.stdout;
if (input === null) throw new Error("relay stdout unavailable");
input.setEncoding("utf8");

function ordinaryData(command) {
  switch (command.type) {
    case "new_session": return { cancelled: false };
    case "get_state": return {};
    case "get_recovery_status": return null;
    case "recover_interrupted_run": return { recovered: false, operationId: null, blocked: [] };
    case "set_model": return model;
    case "cycle_model": return null;
    case "get_available_models": return { models: [model] };
    case "cycle_thinking_level": return null;
    case "get_available_thinking_levels": return { levels: ["off"] };
    case "compact": return {};
    case "bash": return { output: "", exitCode: 0, cancelled: false, truncated: false };
    case "get_session_stats": return {};
    case "export_html": return { path: "/fixture/export.html" };
    case "switch_session": return { cancelled: false };
    case "fork": return { text: "", cancelled: false };
    case "clone": return { cancelled: false };
    case "get_fork_messages": return { messages: [] };
    case "get_entries": return {
      entries: [], leafId: null, sequenceStart: 0, nextSequence: 0, hasMore: false, totalEntries: 0,
    };
    case "get_tree": return { tree: [], leafId: null, nextCursor: null, hasMore: false, totalEntries: 0 };
    case "get_last_assistant_text": return { text: null };
    case "get_messages": return { messages: [], nextCursor: null, hasMore: false, totalMessages: 0 };
    case "get_commands": return { commands: [] };
    default: return undefined;
  }
}

function specialData(command) {
  if (mode === "count-overflow") {
    if (command.type === "get_entries") return {
      entries: [], leafId: null, sequenceStart: 0, nextSequence: 0, hasMore: true, totalEntries: 32769,
    };
    if (command.type === "get_tree") return {
      tree: [], leafId: null, nextCursor: "more", hasMore: true, totalEntries: 32769,
    };
    if (command.type === "get_messages") return {
      messages: [], nextCursor: "more", hasMore: true, totalMessages: 32769,
    };
  }
  if (mode === "messages-byte" && command.type === "get_messages") {
    const page = command.cursor === undefined ? 1 : Number(command.cursor.slice(-1));
    return {
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(11 * 1024 * 1024) }] }],
      nextCursor: page < 3 ? `page-${page + 1}` : null,
      hasMore: page < 3,
      totalMessages: 3,
    };
  }
  if (mode === "entries-stalled" && command.type === "get_entries") return {
    entries: [], leafId: null, sequenceStart: 0, nextSequence: 0, hasMore: true, totalEntries: 2,
  };
  if (mode === "tree-repeated-cursor" && command.type === "get_tree") return {
    tree: command.cursor === undefined ? [node("root", null)] : [],
    leafId: "root",
    nextCursor: "repeat",
    hasMore: true,
    totalEntries: 1,
  };
  if (mode === "messages-repeated-cursor" && command.type === "get_messages") return {
    messages: [], nextCursor: "repeat", hasMore: true, totalMessages: 0,
  };
  if (mode === "tree-duplicate" && command.type === "get_tree") return {
    tree: [node("same", null), node("same", null)],
    leafId: "same", nextCursor: null, hasMore: false, totalEntries: 2,
  };
  if (mode === "tree-cycle" && command.type === "get_tree") return {
    tree: [node("a", "b"), node("b", "a")],
    leafId: "a", nextCursor: null, hasMore: false, totalEntries: 2,
  };
  if (mode === "tree-orphan" && command.type === "get_tree") return {
    tree: [node("orphan", "missing")],
    leafId: "orphan", nextCursor: null, hasMore: false, totalEntries: 1,
  };
  return ordinaryData(command);
}

function respond(command, data = specialData(command)) {
  send({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
}

let pending = "";
input.on("data", (chunk) => {
  pending += chunk;
  while (true) {
    const newline = pending.indexOf("\n");
    if (newline < 0) return;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (line === "") continue;
    const command = JSON.parse(line);

    if (mode === "audit") send({ type: "fixture_command_received", command });
    if (command.type === "extension_ui_response") continue;
    if (mode === "hold") continue;
    if (mode === "mismatch") {
      send({ id: command.id, type: "response", command: "abort", success: true });
      continue;
    }
    if (mode === "malformed-matching") {
      send({ id: command.id, type: "response", command: command.type, success: "yes" });
      continue;
    }
    if (mode === "missing-data") {
      send({ id: command.id, type: "response", command: command.type, success: true });
      continue;
    }
    if (mode === "unmatched-malformed") {
      send({ id: "expired", type: "response", success: "yes" });
    }
    if (mode === "invalid-json") {
      writeFileSync(1, "{not-json}\n");
      continue;
    }
    if (mode === "unknown-event") send({ type: "future_event", payload: "preserved" });

    respond(command);

    if (mode === "pipe-close") {
      relay.once("exit", () => {
        closeSync(0);
        send({ type: "fixture_pipe_closed" });
        setTimeout(() => process.exit(17), 100);
      });
      relay.kill("SIGTERM");
    }
    if (mode === "events-count") {
      for (let index = 0; index <= 4096; index += 1) send({ type: "fixture_burst", index });
      send({ type: "agent_settled" });
    }
    if (mode === "events-bytes") {
      const payload = "x".repeat(12 * 1024 * 1024);
      for (let index = 0; index < 3; index += 1) send({ type: "fixture_burst", index, payload });
      send({ type: "agent_settled" });
    }
    if (command.type === "prompt") send({ type: "agent_settled" });
  }
});

setInterval(() => undefined, 1_000);
