import { TuiController } from "../../src/tui/controller.js";

const terminal = new TuiController({ mode: "accessible", handleSignals: false });
try {
  const secret = await terminal.readSecret("API key: ");
  const answer = await terminal.question("Continue: ");
  if (secret !== "tui-secret-never-render" || answer !== "yes") throw new Error("input mismatch");
} finally {
  terminal.close();
}
process.stdout.write("tui-secret-complete\n");
