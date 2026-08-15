import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { Loader, ProcessTerminal, ScrollView, StdinBuffer, TUI } from "../dist/index.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const LONG_DELAY_MS = MAX_TIMER_DELAY_MS + 5;

class MemoryTerminal {
  columns = 80;
  rows = 24;
  input;
  start(input) { this.input = input; }
  stop() { this.input = undefined; }
  write() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  async drainInput() {}
}

class TimerInput extends EventEmitter {
  isRaw = false;
  setRawMode(value) { this.isRaw = value; return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
}

class TimerOutput extends EventEmitter {
  columns = 80;
  rows = 24;
  write() { return true; }
}

function installFakeTimers() {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const tasks = [];
  const schedule = (kind, callback, delay, args) => {
    const task = {
      kind,
      callback,
      delay: Number(delay ?? 0),
      args,
      active: true,
      unrefed: false,
      handle: undefined,
    };
    task.handle = { unref() { task.unrefed = true; } };
    tasks.push(task);
    return task.handle;
  };
  const clear = (handle) => {
    const task = tasks.find((candidate) => candidate.handle === handle);
    if (task !== undefined) task.active = false;
  };
  globalThis.setTimeout = (callback, delay, ...args) => schedule("timeout", callback, delay, args);
  globalThis.clearTimeout = clear;
  globalThis.setInterval = (callback, delay, ...args) => schedule("interval", callback, delay, args);
  globalThis.clearInterval = clear;
  return {
    tasks,
    activeSince(index) { return tasks.slice(index).filter((task) => task.active); },
    run(task) {
      assert.equal(task.active, true);
      task.active = false;
      task.callback(...task.args);
    },
    restore() {
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
      globalThis.setInterval = original.setInterval;
      globalThis.clearInterval = original.clearInterval;
    },
  };
}

describe("public timer bounds", () => {
  it("rejects invalid delays at each public boundary", async () => {
    const invalid = [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null];
    for (const value of invalid) {
      assert.throws(() => new StdinBuffer({ timeout: value }), /finite, non-negative number/u);
      assert.throws(
        () => new Loader({ requestRender() {} }, (text) => text, (text) => text, "loading", {
          frames: ["only"],
          intervalMs: value,
        }),
        /finite, non-negative number/u,
      );
      assert.throws(
        () => new ScrollView({ render: () => [], invalidate() {} }, { scrollbarHideDelayMs: value }),
        /finite, non-negative number/u,
      );
      const tui = new TUI(new MemoryTerminal());
      assert.throws(() => tui.queryTerminalBackgroundColor({ timeoutMs: value }), /finite, non-negative number/u);
      assert.throws(() => tui.queryTerminalColorScheme({ timeoutMs: value }), /finite, non-negative number/u);

      const terminal = new ProcessTerminal({ input: new TimerInput(), output: new TimerOutput() });
      await assert.rejects(terminal.drainInput(value, 1), /finite, non-negative number/u);
      await assert.rejects(terminal.drainInput(1, value), /finite, non-negative number/u);
    }
  });

  it("chunks long waits without firing early and keeps every timer cancellable", async () => {
    const clock = installFakeTimers();
    try {
      let start = clock.tasks.length;
      const zeroLoader = new Loader({ requestRender() {} }, (text) => text, (text) => text, "loading", {
        frames: ["a", "b"],
        intervalMs: 0,
      });
      const zeroLoaderTimer = clock.activeSince(start)[0];
      assert.equal(zeroLoaderTimer?.kind, "interval");
      assert.equal(zeroLoaderTimer?.delay, 80);
      zeroLoader.stop();

      const inputEvents = [];
      const input = new StdinBuffer({ timeout: LONG_DELAY_MS });
      input.on("data", (value) => inputEvents.push(value));
      start = clock.tasks.length;
      input.process("\x1b[");
      const inputFirst = clock.activeSince(start)[0];
      assert.equal(inputFirst?.delay, MAX_TIMER_DELAY_MS);
      clock.run(inputFirst);
      assert.deepEqual(inputEvents, []);
      const inputLast = clock.activeSince(start)[0];
      assert.equal(inputLast?.delay, 5);
      clock.run(inputLast);
      assert.deepEqual(inputEvents, ["\x1b["]);

      input.process("\x1b[");
      const cancelledInput = clock.activeSince(start)[0];
      input.destroy();
      assert.equal(cancelledInput?.active, false);

      let loaderRenders = 0;
      start = clock.tasks.length;
      const loader = new Loader({ requestRender() { loaderRenders += 1; } }, (text) => text, (text) => text, "loading", {
        frames: ["a", "b"],
        intervalMs: LONG_DELAY_MS,
      });
      const loaderFirst = clock.activeSince(start)[0];
      assert.equal(loaderRenders, 1);
      assert.equal(loaderFirst?.kind, "timeout");
      assert.equal(loaderFirst?.delay, MAX_TIMER_DELAY_MS);
      clock.run(loaderFirst);
      assert.equal(loaderRenders, 1);
      const loaderLast = clock.activeSince(start)[0];
      assert.equal(loaderLast?.delay, 5);
      clock.run(loaderLast);
      assert.equal(loaderRenders, 2);
      const nextLoaderInterval = clock.activeSince(start)[0];
      assert.equal(nextLoaderInterval?.delay, MAX_TIMER_DELAY_MS);
      loader.stop();
      assert.equal(nextLoaderInterval?.active, false);

      let scrollRenders = 0;
      start = clock.tasks.length;
      const scroll = new ScrollView({
        render: () => ["one", "two", "three"],
        invalidate() {},
      }, { scrollbar: "auto", scrollbarHideDelayMs: LONG_DELAY_MS });
      scroll.renderViewport(8, 1, () => { scrollRenders += 1; });
      scroll.setScrollbarActive(true);
      scroll.setScrollbarActive(false);
      const scrollFirst = clock.activeSince(start)[0];
      assert.equal(scrollFirst?.delay, MAX_TIMER_DELAY_MS);
      assert.equal(scrollFirst?.unrefed, true);
      clock.run(scrollFirst);
      assert.equal(scroll.isScrollbarVisible, true);
      const scrollLast = clock.activeSince(start)[0];
      assert.equal(scrollLast?.delay, 5);
      assert.equal(scrollLast?.unrefed, true);
      clock.run(scrollLast);
      assert.equal(scroll.isScrollbarVisible, false);
      assert.equal(scrollRenders, 1);
      scroll.dispose();

      const tui = new TUI(new MemoryTerminal());
      tui.start();
      start = clock.tasks.length;
      const background = tui.queryTerminalBackgroundColor({ timeoutMs: LONG_DELAY_MS });
      const scheme = tui.queryTerminalColorScheme({ timeoutMs: LONG_DELAY_MS });
      const [backgroundFirst, schemeFirst] = clock.activeSince(start);
      assert.deepEqual([backgroundFirst?.delay, schemeFirst?.delay], [MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS]);
      clock.run(backgroundFirst);
      const backgroundLast = clock.activeSince(start).at(-1);
      clock.run(schemeFirst);
      const schemeLast = clock.activeSince(start).at(-1);
      assert.equal(backgroundLast?.delay, 5);
      assert.equal(schemeLast?.delay, 5);
      clock.run(backgroundLast);
      clock.run(schemeLast);
      assert.deepEqual(await Promise.all([background, scheme]), [undefined, undefined]);
      tui.stop();

      const originalNow = Date.now;
      let now = 0;
      Date.now = () => now;
      try {
        const terminal = new ProcessTerminal({ input: new TimerInput(), output: new TimerOutput() });
        start = clock.tasks.length;
        const draining = terminal.drainInput(LONG_DELAY_MS, LONG_DELAY_MS);
        const drainFirst = clock.activeSince(start)[0];
        assert.equal(drainFirst?.delay, MAX_TIMER_DELAY_MS);
        now += drainFirst.delay;
        clock.run(drainFirst);
        const drainLast = clock.activeSince(start)[0];
        assert.equal(drainLast?.delay, 5);
        now += drainLast.delay;
        clock.run(drainLast);
        await draining;
      } finally {
        Date.now = originalNow;
      }
    } finally {
      clock.restore();
    }
  });
});
