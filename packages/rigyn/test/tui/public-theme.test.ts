import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TuiController } from "../../src/tui/controller.js";
import {
  currentTheme,
  initTheme,
  stopThemeWatcher,
} from "../../src/tui/public-theme.js";
import { FakeInput, FakeOutput } from "./helpers.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for theme refresh");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("public theme initialization defaults to signal", (context) => {
  const previousNoColor = process.env.NO_COLOR;
  context.after(() => {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
    initTheme("mono");
  });
  delete process.env.NO_COLOR;
  initTheme();
  assert.equal(currentTheme().name, "signal");
});

test("public initTheme watches the selected user theme when requested", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-public-theme-"));
  const agentDirectory = join(root, "agent");
  const themes = join(agentDirectory, "themes");
  const path = join(themes, "watched.json");
  const previousAgentDirectory = process.env.RIGYN_HOME;
  context.after(async () => {
    stopThemeWatcher();
    initTheme("mono");
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
    await rm(root, { recursive: true, force: true });
  });
  process.env.RIGYN_HOME = agentDirectory;
  await mkdir(themes, { recursive: true });
  const definition = (foreground: number) => JSON.stringify({
    schemaVersion: 1,
    name: "watched",
    base: "dark",
    styles: { accent: { foreground } },
  });
  await writeFile(path, definition(33));

  initTheme("watched", true);
  const initial = currentTheme();
  await writeFile(path, definition(34));
  await waitFor(() => currentTheme() !== initial);
  assert.equal(currentTheme().name, initial.name);
});

test("the active controller synchronizes exported compatibility components", () => {
  initTheme("mono");
  const controller = new TuiController({
    input: new FakeInput(),
    output: new FakeOutput(),
    theme: "signal",
    handleSignals: false,
  });
  assert.equal(currentTheme().name, "signal");
  controller.setTheme("mono");
  assert.equal(currentTheme().name, "mono");
  controller.close();
});
