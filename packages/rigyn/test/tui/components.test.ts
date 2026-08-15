import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

import {
  RuntimeUiComponentMount,
  sanitizeRuntimeUiBlock,
  type RuntimeUiComponentHost,
  type RuntimeUiRenderContext,
} from "../../src/tui/components.js";
import { RawComponentMount } from "../../src/tui/raw-mount.js";
import { cellWidth } from "../../src/tui/unicode.js";

const context: RuntimeUiRenderContext = {
  width: 20,
  height: 10,
  focused: true,
  expanded: false,
  theme: { name: "mono", color: true, unicode: true },
};

test("runtime UI blocks strip terminal controls and clip spans by cell width", () => {
  const block = sanitizeRuntimeUiBlock({
    lines: [{
      spans: [
        { text: "\u001b[31mred\u001b[0m\u001b]2;owned\u0007\n界界", role: "accent" },
        { text: "never visible", role: "error" },
      ],
      fill: true,
    }],
    cursor: { row: 0, column: 6 },
  }, { width: 6 });

  assert.deepEqual(block, {
    lines: [{ spans: [{ text: "red 界", role: "accent" }], fill: true }],
    cursor: { row: 0, column: 6 },
  });
  const text = block.lines[0]!.spans.map((span) => span.text).join("");
  assert.equal(cellWidth(text), 6);
  assert.doesNotMatch(text, /[\u001b\u0007]/u);
  assert.equal(Object.isFrozen(block), true);
  assert.equal(Object.isFrozen(block.lines[0]!.spans), true);
});

test("runtime UI block validation bounds shape, bytes, lines, spans, roles, and cursor", () => {
  assert.throws(
    () => sanitizeRuntimeUiBlock({ lines: [], raw: "escape hatch" }, { width: 10 }),
    /unknown keys: raw/u,
  );
  assert.throws(
    () => sanitizeRuntimeUiBlock({ lines: [{ spans: [{ text: "x", role: "rawAnsi" }] }] }, { width: 10 }),
    /role is invalid/u,
  );
  assert.throws(
    () => sanitizeRuntimeUiBlock({ lines: [{ spans: [] }, { spans: [] }] }, { width: 10, maxLines: 1 }),
    /exceeds 1 lines/u,
  );
  assert.throws(
    () => sanitizeRuntimeUiBlock({ lines: [{ spans: [{ text: "abc" }] }] }, { width: 10, maxBytes: 2 }),
    /exceeds 2 bytes/u,
  );
  assert.throws(
    () => sanitizeRuntimeUiBlock({ lines: [{ spans: [{ text: "" }, { text: "" }] }] }, { width: 10, maxSpansPerLine: 1 }),
    /exceeds 1 spans/u,
  );
  assert.throws(
    () => sanitizeRuntimeUiBlock({ lines: [{ spans: [{ text: "x" }] }], cursor: { row: 0, column: 2 } }, { width: 10 }),
    /outside its rendered line/u,
  );
});

test("component mounts bind generation, sanitize keys, and close and dispose once", () => {
  const generation = new AbortController();
  const events: string[] = [];
  let host: RuntimeUiComponentHost<string> | undefined;
  const mount = RuntimeUiComponentMount.create<string>((value) => {
    host = value;
    return {
      render: () => ({ lines: [{ spans: [{ text: "ready" }] }] }),
      handleKey: (event) => {
        events.push(`${event.key}:${event.text ?? ""}:${event.ctrl}`);
        return true;
      },
      invalidate: () => events.push("invalidate"),
      dispose: () => events.push("dispose"),
    };
  }, {
    signal: generation.signal,
    requestRender: () => events.push("render"),
    onClose: (_value, reason) => events.push(`close:${reason}`),
  });

  host!.requestRender();
  mount.invalidate();
  assert.equal(mount.handleKey({ key: "text", text: "ok\u001b]2;owned\u0007", ctrl: true }), true);
  assert.deepEqual(mount.render(context), {
    ok: true,
    block: { lines: [{ spans: [{ text: "ready" }] }] },
  });
  generation.abort(new Error("refresh"));
  mount.close();
  host!.requestRender();
  mount.invalidate();

  assert.equal(mount.closed, true);
  assert.equal(mount.signal.aborted, true);
  assert.deepEqual(events, ["render", "invalidate", "text:ok:true", "dispose", "close:generation"]);
});

test("component render and lifecycle failures remain non-throwing when diagnostics fail", () => {
  const generation = new AbortController();
  let diagnostics = 0;
  const mount = RuntimeUiComponentMount.create(() => ({
    render: () => { throw new Error("render failed"); },
    handleKey: () => { throw new Error("key failed"); },
    invalidate: () => { throw new Error("invalidate failed"); },
    dispose: () => { throw new Error("dispose failed"); },
  }), {
    signal: generation.signal,
    requestRender: () => { throw new Error("request failed"); },
    onClose: () => { throw new Error("close failed"); },
    onError: () => {
      diagnostics += 1;
      throw new Error("diagnostic failed");
    },
  });

  const result = mount.render(context);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /render failed/u);
  assert.equal(mount.handleKey({ key: "x" }), false);
  assert.doesNotThrow(() => mount.invalidate());
  assert.doesNotThrow(() => mount.close());
  assert.doesNotThrow(() => mount.close());
  assert.equal(diagnostics, 5);
});

test("component mounts contain hostile thrown objects without inspecting them", () => {
  let traps = 0;
  const hostile = new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("prototype trap ran");
    },
    get() {
      traps += 1;
      throw new Error("property trap ran");
    },
  });
  const runtimeErrors: string[] = [];
  const runtime = RuntimeUiComponentMount.create(() => ({
    render: () => { throw hostile; },
  }), {
    signal: new AbortController().signal,
    requestRender() {},
    onError: (cause) => runtimeErrors.push(cause.message),
  });
  const runtimeResult = runtime.render(context);
  assert.equal(runtimeResult.ok, false);
  if (!runtimeResult.ok) assert.equal(runtimeResult.error.message, "[Thrown object]");
  assert.deepEqual(runtimeErrors, ["[Thrown object]"]);

  const rawErrors: string[] = [];
  const raw = new RawComponentMount({
    render: () => { throw hostile; },
    invalidate() {},
  }, {
    signal: new AbortController().signal,
    requestRender() {},
    onError: (cause) => rawErrors.push(cause.message),
  });
  const rawResult = raw.render(20);
  assert.equal(rawResult.ok, false);
  if (!rawResult.ok) assert.equal(rawResult.error.message, "[Thrown object]");
  assert.deepEqual(rawErrors, ["[Thrown object]"]);
  assert.equal(traps, 0);
});

test("component mounts reject hostile factory returns without inspecting or leaking listeners", () => {
  let traps = 0;
  const hostile = new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("prototype trap ran");
    },
    get() {
      traps += 1;
      throw new Error("property trap ran");
    },
    has() {
      traps += 1;
      throw new Error("has trap ran");
    },
  });
  let runtimeError: unknown;
  try {
    RuntimeUiComponentMount.create(() => hostile as never, {
      signal: new AbortController().signal,
      requestRender() {},
    });
  } catch (cause) {
    runtimeError = cause;
  }
  const generation = new AbortController();
  const listenersBefore = getEventListeners(generation.signal, "abort").length;
  let rawError: unknown;
  try {
    new RawComponentMount(hostile as never, {
      signal: generation.signal,
      requestRender() {},
    });
  } catch (cause) {
    rawError = cause;
  }

  assert.match(runtimeError instanceof Error ? runtimeError.message : "", /must return a component/u);
  assert.match(rawError instanceof Error ? rawError.message : "", /must provide render/u);
  assert.equal(getEventListeners(generation.signal, "abort").length, listenersBefore);
  assert.equal(traps, 0);
});

test("component may close during construction and is still disposed exactly once", () => {
  const generation = new AbortController();
  const events: string[] = [];
  const mount = RuntimeUiComponentMount.create<string>((host) => {
    host.close("ready");
    return {
      render: () => ({ lines: [] }),
      dispose: () => events.push("dispose"),
    };
  }, {
    signal: generation.signal,
    requestRender() {},
    onClose: (value, reason) => events.push(`${value}:${reason}`),
  });

  generation.abort();
  mount.close();
  assert.deepEqual(events, ["dispose", "ready:component"]);
});

test("component mounts support asynchronous factories and render after resolution", async () => {
  const generation = new AbortController();
  let resolveComponent!: (value: { render(): { lines: Array<{ spans: Array<{ text: string }> }> }; dispose(): void }) => void;
  const component = new Promise<{ render(): { lines: Array<{ spans: Array<{ text: string }> }> }; dispose(): void }>((resolve) => {
    resolveComponent = resolve;
  });
  const events: string[] = [];
  const mount = RuntimeUiComponentMount.create(async () => await component, {
    signal: generation.signal,
    requestRender: () => events.push("render"),
    onError: (cause) => events.push(`error:${cause.message}`),
  });
  assert.deepEqual(mount.render(context), { ok: true, block: { lines: [] } });
  resolveComponent({
    render: () => ({ lines: [{ spans: [{ text: "async ready" }] }] }),
    dispose: () => events.push("dispose"),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(mount.render(context), {
    ok: true,
    block: { lines: [{ spans: [{ text: "async ready" }] }] },
  });
  assert.deepEqual(events, ["render"]);
  mount.close();
  assert.deepEqual(events, ["render", "dispose"]);
});

test("async component rejection reports only while its generation remains active", async () => {
  const rejectAfter = async (abortFirst: boolean): Promise<{ errors: string[]; closes: string[] }> => {
    const generation = new AbortController();
    let rejectComponent!: (cause: Error) => void;
    const component = new Promise<never>((_resolve, reject) => { rejectComponent = reject; });
    const errors: string[] = [];
    const closes: string[] = [];
    RuntimeUiComponentMount.create(() => component, {
      signal: generation.signal,
      requestRender() {},
      onClose: (_value, reason) => closes.push(reason),
      onError: (cause) => errors.push(cause.message),
    });
    if (abortFirst) generation.abort(new Error("extension generation disabled"));
    rejectComponent(new Error(abortFirst ? "stale factory rejection" : "active factory rejection"));
    await Promise.resolve();
    await Promise.resolve();
    return { errors, closes };
  };

  assert.deepEqual(await rejectAfter(true), { errors: [], closes: ["generation"] });
  assert.deepEqual(await rejectAfter(false), { errors: ["active factory rejection"], closes: ["owner"] });
});
