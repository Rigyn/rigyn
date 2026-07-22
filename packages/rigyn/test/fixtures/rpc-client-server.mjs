import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.RIGYN_RPC_FIXTURE_MODE;

if (mode === "exit") {
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
      writeFileSync(1, `${JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
      })}\n`);
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
