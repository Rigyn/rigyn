import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("advanced UI declares bounded structural chrome and disposes its non-consuming observer", () => {
  const components = [];
  const requests = [];
  const settings = [];
  let observer;
  let observerDisposals = 0;
  let dispose;
  activate({
    workspace: "/workspace/project",
    ui: {
      advanced: {
        setComponent(slot, key, factory) { components.push({ slot, key, factory }); },
        setWorkingIndicator(value) { settings.push({ type: "working", value }); },
        setHiddenReasoningLabel(value) { settings.push({ type: "reasoning", value }); },
        setToolOutputExpanded(value) { settings.push({ type: "tools", value }); },
        observeKeys(value) {
          observer = value;
          let disposed = false;
          return () => {
            if (disposed) return;
            disposed = true;
            observerDisposals += 1;
          };
        },
      },
    },
    onDispose(value) { dispose = value; },
  });

  assert.deepEqual(components.map(({ slot, key }) => ({ slot, key })), [
    { slot: "header", key: "workspace" },
    { slot: "widget", key: "activity" },
    { slot: "footer", key: "help" },
  ]);
  const mounts = components.map(({ factory }) => factory({
    signal: new AbortController().signal,
    requestRender() { requests.push("render"); },
    close() {},
  }));
  const renderContext = {
    width: 80,
    height: 24,
    focused: false,
    expanded: false,
    theme: { name: "dark", color: true, unicode: true },
  };
  const blocks = mounts.map((mount) => mount.render(renderContext));
  assert.equal(blocks.every((block) => block.lines.length === 1), true);
  assert.equal(JSON.stringify(blocks).includes("\u001b"), false);
  assert.deepEqual(settings, [
    { type: "working", value: { frames: ["·", "•", "●", "•"], intervalMs: 120 } },
    { type: "reasoning", value: "reasoning" },
    { type: "tools", value: true },
  ]);

  assert.equal(observer({ key: "left", ctrl: false, alt: false, shift: false }), undefined);
  assert.equal(requests.length, 3);
  assert.match(mounts[1].render(renderContext).lines[0].spans.map((span) => span.text).join(""), /1 · last left/u);
  dispose();
  dispose();
  assert.equal(observerDisposals, 1);
  for (const mount of mounts) mount.dispose();
});
