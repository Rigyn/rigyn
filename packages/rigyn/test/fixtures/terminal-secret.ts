import { TerminalController } from "../../src/interfaces/terminal.js";

const terminal = new TerminalController();
try {
  const secret = await terminal.readSecret("API key: ");
  const provider = await terminal.question("Provider: ");
  if (secret !== "dummy-secret-never-render" || provider !== "openai") throw new Error("input mismatch");
} finally {
  terminal.close();
}
process.stdout.write("terminal-secret-complete\n");
