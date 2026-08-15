import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTheme } from "../../src/tui/theme.js";
import { cellWidth, stripAnsi } from "../../src/tui/unicode.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function renderAtWidth(columns: number): Promise<string> {
  const fixture = fileURLToPath(new URL("../fixtures/tui-user-message-layout.ts", import.meta.url));
  const command = `stty cols ${columns} rows 20; TERM=xterm-256color ${[
    process.execPath,
    "--import",
    "tsx",
    fixture,
  ].map(shellQuote).join(" ")}`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let rendered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { rendered += chunk; });
  child.stderr.on("data", (chunk: string) => { rendered += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, rendered);
  return rendered.replaceAll("\r", "");
}

test("real PTYs keep user and host-framed tool cards full width", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async () => {
  const background = createTheme("signal", { color: true, unicode: true }).getBgAnsi("userMessageBg");
  const signalTheme = createTheme("signal", { color: true, unicode: true });
  const toolBackground = signalTheme.getBgAnsi("toolPendingBg");
  for (const columns of [188, 42, 12]) {
    const rendered = await renderAtWidth(columns);
    const start = rendered.indexOf("user-message-start\n");
    const end = rendered.indexOf("\nuser-message-end", start);
    assert.ok(start >= 0 && end > start, rendered);
    const card = rendered.slice(start + "user-message-start\n".length, end).split("\n");
    assert.ok(card.length >= 5, rendered);
    assert.ok(card.every((line) => line.includes(background)), rendered);
    assert.ok(card.every((line) => cellWidth(stripAnsi(line)) === columns), rendered);
    assert.equal(stripAnsi(card[0]!).trim(), "");
    assert.equal(stripAnsi(card.at(-1)!).trim(), "");
    assert.match(stripAnsi(card.join("\n")), /你好🙂[\s\S]*alpha[\s\S]*beta[\s\S]*omega/u);

    const imageStart = rendered.indexOf("image-only-message-start\n");
    const imageEnd = rendered.indexOf("\nimage-only-message-end", imageStart);
    assert.ok(imageStart >= 0 && imageEnd > imageStart, rendered);
    const imageCard = rendered.slice(imageStart + "image-only-message-start\n".length, imageEnd).split("\n");
    assert.ok(imageCard.length >= 3, rendered);
    assert.ok(imageCard.every((line) => line.includes(background)), rendered);
    assert.ok(imageCard.every((line) => cellWidth(stripAnsi(line)) === columns), rendered);
    const imageText = stripAnsi(imageCard.join("\n"));
    assert.match(imageText, /\[Image:/u);
    if (columns >= 20) assert.match(imageText, /image\/png/u);

    const toolStart = rendered.indexOf("tool-card-start\n");
    const toolEnd = rendered.indexOf("\ntool-card-end", toolStart);
    assert.ok(toolStart >= 0 && toolEnd > toolStart, rendered);
    const toolSection = rendered.slice(toolStart + "tool-card-start\n".length, toolEnd).split("\n");
    const toolHeaderIndex = toolSection.findIndex((line) => stripAnsi(line).includes("$ npm test"));
    assert.ok(toolHeaderIndex >= 0, rendered);
    const framedToolRows = toolSection.slice(toolHeaderIndex);
    assert.ok(framedToolRows.every((line) => line.includes(toolBackground)), rendered);
    assert.ok(framedToolRows.every((line) => cellWidth(stripAnsi(line)) === columns), rendered);
    assert.ok(toolSection.every((line) => cellWidth(stripAnsi(line)) <= columns), rendered);
    const toolText = stripAnsi(toolSection.join("\n"));
    assert.match(toolText, /\$ npm test/u);
    assert.match(toolText.replaceAll(/\s*│\s*/gu, " ").replaceAll(/\s+/gu, " "), /wide tool output/u);

    const dockStart = rendered.indexOf("status-dock-start\n");
    const dockEnd = rendered.indexOf("\nstatus-dock-end", dockStart);
    assert.ok(dockStart >= 0 && dockEnd > dockStart, rendered);
    const dock = rendered.slice(dockStart + "status-dock-start\n".length, dockEnd).split("\n");
    const dockText = stripAnsi(dock.join("\n"));
    assert.equal(dock.length, 12, rendered);
    assert.ok(dock.every((line) => cellWidth(stripAnsi(line)) <= columns), rendered);
    assert.match(dockText, columns >= 42 ? /Running bash · \d+s/u : /Running/u);
    assert.match(dockText, /max/u);
    if (columns >= 42) assert.match(dockText, /in 22k/u);
    if (columns >= 188) {
      assert.match(dockText, /gpt-test · max/u);
      assert.match(dockText, /ctx (?:\[[█░]+\] )?47\.2%\/100k/u);
      assert.doesNotMatch(dockText, /auto/u);
      assert.match(dockText, /in 22k · out 860 · last cache 91\.0%/u);
    }
  }
});
