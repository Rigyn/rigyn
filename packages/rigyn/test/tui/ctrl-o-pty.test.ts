import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("real PTY Ctrl+O expands a running tool, applies to a later tool, and collapses both", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-ctrl-o-pty-"));
  const markerPath = join(root, "markers.log");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const fixture = fileURLToPath(new URL("../fixtures/tui-tool-expansion.ts", import.meta.url));
  const command = [
    "stty cols 72 rows 44",
    `TERM=xterm-256color NO_COLOR=1 ${[
      process.execPath,
      "--import",
      "tsx",
      fixture,
    ].map(shellQuote).join(" ")}`,
  ].join("; ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    env: { ...process.env, RIGYN_CTRL_O_PTY_MARKERS: markerPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const markers = async (): Promise<string[]> => {
    if (!existsSync(markerPath)) return [];
    return (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean);
  };
  const waitForMarker = async (marker: string): Promise<void> => {
    await waitFor(
      async () => (await markers()).includes(marker),
      `missing ${marker} marker:\n${rendered}`,
    );
  };

  await waitForMarker("ready:false");
  child.stdin.write(Buffer.from([0x0f]));
  await waitForMarker("expanded:true");
  await waitForMarker("later:true");
  await waitFor(
    () => rendered.includes("current-expanded-tail-sentinel")
      && rendered.includes("later-inherited-tail-sentinel"),
    `expanded tool tails were not rendered:\n${rendered}`,
  );

  child.stdin.write(Buffer.from([0x0f]));
  await waitForMarker("collapsed:false");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Ctrl+O PTY fixture did not exit:\n${rendered}`));
    }, 10_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.equal(exitCode, 0, rendered);
  assert.deepEqual(await markers(), ["ready:false", "expanded:true", "later:true", "collapsed:false"]);
  assert.equal(rendered.split("current-expanded-tail-sentinel").length - 1, 1, rendered);
  assert.equal(rendered.split("later-inherited-tail-sentinel").length - 1, 1, rendered);
  assert.doesNotMatch(rendered, /(?:\^O|\u000f)/u);
  assert.equal(rendered.match(/\u001b\[\?1049h/gu)?.length, 1, rendered);
  assert.equal(rendered.match(/\u001b\[\?1049l/gu)?.length, 1, rendered);
  assert.doesNotMatch(rendered, /\u001b\[3J/u);
  assert.doesNotMatch(rendered, /ctrl-o-pty-error/u);
  assert.match(rendered, /ctrl-o-pty-complete/u);
});
