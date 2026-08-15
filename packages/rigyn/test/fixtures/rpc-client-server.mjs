import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.RIGYN_RPC_FIXTURE_MODE;

if (mode === "exit" || mode === "stderr-overflow") {
  if (mode === "stderr-overflow") {
    process.stderr.write(`discarded-prefix\n${"x".repeat(1024 * 1024)}\nretained-tail-marker\n`);
  }
  setTimeout(() => process.exit(7), 250);
  setInterval(() => undefined, 1_000);
} else {
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
  });
  const input = relay.stdout;
  if (input === null) throw new Error("relay stdout unavailable");
  let pending = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    pending += chunk;
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line === "") continue;
      const command = JSON.parse(line);
      if (mode === "image-echo") {
        writeFileSync(1, `${JSON.stringify({ type: "fixture_command_received", command })}\n`);
      }
      if (command.type === "extension_ui_response") {
        writeFileSync(1, `${JSON.stringify({
          type: "extension_ui_received",
          response: command,
        })}\n`);
        continue;
      }
      if (command.type === "bash") {
        writeFileSync(1, `${JSON.stringify({
          type: "bash_execution_update",
          id: command.id,
          delta: "fixture output",
        })}\n`);
      }
      const paginationData = mode !== "pagination" ? undefined
        : command.type === "get_tree" ? command.cursor === undefined ? {
          tree: [{
            entry: {
              type: "thinking_level_change",
              id: "tree-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              thinkingLevel: "off",
            },
            children: [],
          }],
          leafId: "tree-3",
          nextCursor: "tree-page-2",
          hasMore: true,
          totalEntries: 3,
        } : {
          tree: [
            {
              entry: {
                type: "thinking_level_change",
                id: "tree-2",
                parentId: "tree-1",
                timestamp: "2026-01-01T00:00:01.000Z",
                thinkingLevel: "low",
              },
              children: [],
            },
            {
              entry: {
                type: "thinking_level_change",
                id: "tree-3",
                parentId: "tree-2",
                timestamp: "2026-01-01T00:00:02.000Z",
                thinkingLevel: "high",
              },
              children: [],
            },
          ],
          leafId: "tree-3",
          nextCursor: null,
          hasMore: false,
          totalEntries: 3,
        } : command.type === "get_entries" ? (command.afterSequence ?? 0) === 0 ? {
          entries: [{ type: "thinking_level_change", id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", thinkingLevel: "off" }],
          leafId: "entry-2",
          sequenceStart: 1,
          nextSequence: 1,
          hasMore: true,
          totalEntries: 2,
        } : {
          entries: [{ type: "thinking_level_change", id: "entry-2", parentId: "entry-1", timestamp: "2026-01-01T00:00:01.000Z", thinkingLevel: "high" }],
          leafId: "entry-2",
          sequenceStart: 2,
          nextSequence: 2,
          hasMore: false,
          totalEntries: 2,
        } : command.type === "get_messages" ? command.cursor === undefined ? {
          messages: [{ role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 }],
          nextCursor: "message-page-2",
          hasMore: true,
          totalMessages: 2,
        } : {
          messages: [{ role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2 }],
          nextCursor: null,
          hasMore: false,
          totalMessages: 2,
        } : undefined;
      const availableModels = command.type === "get_available_models" ? {
        models: [{
          id: "fixture-model",
          name: "Fixture model",
          provider: "fixture",
          api: "openai-responses",
          baseUrl: "https://example.invalid",
          reasoning: true,
          input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
          contextWindow: 128000,
          maxTokens: 8192,
        }],
      } : undefined;
      const recoveryData = command.type === "get_recovery_status" ? {
        operationId: "operation-fixture",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        cancelled: false,
        attempts: 1,
        claimedQueueIds: [],
        effects: [],
      } : command.type === "recover_interrupted_run" ? {
        recovered: true,
        operationId: command.resolutions?.[0]?.effectId ?? "operation-fixture",
        blocked: [],
      } : undefined;
      writeFileSync(1, `${JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        ...(command.type === "bash" ? {
          data: { output: "fixture output", exitCode: 0, cancelled: false, truncated: false },
        } : availableModels !== undefined ? {
          data: availableModels,
        } : recoveryData !== undefined ? {
          data: recoveryData,
        } : paginationData === undefined ? {} : { data: paginationData }),
      })}\n`);
      if (mode === "unmatched") {
        writeFileSync(1, `${JSON.stringify({
          id: "req_expired",
          type: "response",
          command: command.type,
          success: true,
        })}\n`);
        writeFileSync(1, `${JSON.stringify({ type: "agent_settled" })}\n`);
      }
      if (command.type === "prompt") {
        writeFileSync(1, `${JSON.stringify({ type: "agent_start" })}\n`);
        writeFileSync(1, `${JSON.stringify({ type: "agent_end" })}\n`);
        writeFileSync(1, `${JSON.stringify({ type: "queued_follow_up_processed" })}\n`);
        writeFileSync(1, `${JSON.stringify({ type: "agent_settled" })}\n`);
      }
    }
  });
  setInterval(() => undefined, 1_000);
}
