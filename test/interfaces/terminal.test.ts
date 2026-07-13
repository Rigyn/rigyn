import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import { TerminalController, readSecretFrom } from "../../src/interfaces/terminal.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForOutput(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("terminal picker supports filtering and numbered selection", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rendered: Buffer[] = [];
  output.on("data", (chunk: Buffer) => rendered.push(chunk));
  const terminal = new TerminalController(input, output);
  const selection = terminal.choose("Select model", [
    { label: "alpha-fast", value: "a" },
    { label: "beta-smart", detail: "large context", value: "b" },
  ]);
  input.write("smart\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write("1\n");
  assert.equal(await selection, "b");
  assert.match(Buffer.concat(rendered).toString("utf8"), /beta-smart/u);
  terminal.close();
});

test("terminal secret input preserves piped input behavior", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new TerminalController(input, output);
  const secret = terminal.readSecret("Secret: ");
  input.end("piped-secret\n");
  assert.equal(await secret, "piped-secret");
  assert.equal(output.readableLength, 0);
  terminal.close();
});

test("piped secret input is bounded and cancellable", async () => {
  const oversized = new PassThrough();
  const ignoredOutput = new PassThrough();
  const oversizedRead = readSecretFrom(oversized, ignoredOutput, "ignored");
  oversized.end(Buffer.alloc(64 * 1024 + 3, 97));
  await assert.rejects(oversizedRead, /exceeds 65536 bytes/u);

  const waiting = new PassThrough();
  const controller = new AbortController();
  const cancelled = readSecretFrom(waiting, ignoredOutput, "ignored", controller.signal);
  controller.abort(new Error("credential prompt cancelled"));
  await assert.rejects(cancelled, /credential prompt cancelled/u);
});

test("TTY secret input preserves UTF-8 and backspaces one complete character", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(mode: boolean): void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  const secret = readSecretFrom(input, output, "Secret: ");
  input.write(Buffer.concat([Buffer.from("sëx", "utf8"), Buffer.from([127]), Buffer.from("cret\n", "utf8")]));
  assert.equal(await secret, "sëcret");
});

test("terminal secret input is hidden and ordinary questions resume in a PTY", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const fixture = fileURLToPath(new URL("../fixtures/terminal-secret.ts", import.meta.url));
  const command = [process.execPath, "--import", "tsx", fixture].map(shellQuote).join(" ");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RIGYN_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64url"),
  };
  delete environment.OPENAI_API_KEY;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let rendered = "";
  child.stdout.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });

  await waitForOutput(() => rendered, "API key: ");
  const secret = "dummy-secret-never-render";
  child.stdin.write(`${secret}\n`);
  await waitForOutput(() => rendered, "Provider: ");
  child.stdin.write("openai\n");

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  assert.doesNotMatch(rendered, new RegExp(secret, "u"));
  assert.match(rendered, /terminal-secret-complete/u);
});
