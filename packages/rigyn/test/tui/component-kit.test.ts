import assert from "node:assert/strict";
import test from "node:test";

import {
  RuntimeUiComponentMount,
  type RuntimeUiRenderContext,
} from "../../src/tui/components.js";
import {
  uiMarkdown,
  uiPanel,
  uiStack,
  uiText,
  type RuntimeUiView,
} from "../../src/tui/component-kit.js";
import { cellWidth } from "../../src/tui/unicode.js";

function context(overrides: Partial<RuntimeUiRenderContext> = {}): RuntimeUiRenderContext {
  return {
    width: 20,
    height: 10,
    focused: true,
    expanded: false,
    theme: { name: "mono", color: true, unicode: true },
    ...overrides,
  };
}

function text(view: RuntimeUiView, selected: RuntimeUiRenderContext): string {
  return view.render(selected).lines
    .map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

test("text views strip controls, preserve graphemes, clip by cells, and bound history", () => {
  const view = uiText("one\u001b[31m\u001b[0m\u0007\n界界\n🇨🇦界\nnever", {
    role: "accent",
    wrap: false,
    fill: true,
    maxLines: 3,
  });
  const first = view.render(context({ width: 3, height: 8 }));
  const second = view.render(context({ width: 3, height: 8 }));

  assert.deepEqual(first, second);
  assert.deepEqual(first.lines, [
    { spans: [{ text: "one", role: "accent" }], fill: true },
    { spans: [{ text: "界…", role: "accent" }], fill: true },
    { spans: [{ text: "…", role: "muted" }] },
  ]);
  assert.ok(first.lines.every((line) => cellWidth(line.spans.map((span) => span.text).join("")) <= 3));
  assert.doesNotMatch(text(view, context({ width: 3 })), /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(first), true);
});

test("Markdown views reuse semantic parsing while removing terminal control injection", () => {
  const view = uiMarkdown("# Heading\n\n**bold** and `code`\n\u001b]2;owned\u0007four\nfive", {
    role: "info",
    maxLines: 4,
  });
  const rendered = view.render(context({ width: 30, height: 6 }));
  const visible = rendered.lines.map((line) => line.spans.map((span) => span.text).join(""));

  assert.equal(visible[0], "# Heading");
  assert.equal(visible.at(-1), "…");
  assert.ok(rendered.lines.flatMap((line) => line.spans).some((span) => span.role === "title"));
  assert.ok(rendered.lines.flatMap((line) => line.spans).some((span) => span.role === "accent"));
  assert.doesNotMatch(visible.join("\n"), /[\u001b\u0007]/u);
  assert.ok(visible.every((line) => cellWidth(line) <= 30));
});

test("stack and panel compose bounded views and preserve host focus ownership", () => {
  const observed: RuntimeUiRenderContext[] = [];
  const child: RuntimeUiView = {
    render(selected) {
      observed.push(selected);
      return {
        lines: [{ spans: [{ text: "界x\u001b[31m", role: "accent" }] }],
        cursor: { row: 0, column: 2 },
      };
    },
  };
  const view = uiPanel(uiStack([
    child,
    uiText("ready", { role: "success" }),
  ], { gap: 1 }), {
    title: "T🙂\u001b]2;owned\u0007",
    padding: 1,
  });

  const unfocused = view.render(context({ width: 10, height: 6, focused: false }));
  assert.equal(unfocused.cursor, undefined);
  assert.equal(observed[0]?.focused, false);
  assert.equal(observed[0]?.width, 6);
  assert.ok(unfocused.lines.every((line) => cellWidth(line.spans.map((span) => span.text).join("")) === 10));
  assert.match(unfocused.lines[0]?.spans.map((span) => span.text).join("") ?? "", /^┌/u);
  assert.doesNotMatch(unfocused.lines.flatMap((line) => line.spans).map((span) => span.text).join(""), /[\u001b\u0007]/u);

  const focused = view.render(context({ width: 10, height: 6, focused: true }));
  assert.deepEqual(focused.cursor, { row: 1, column: 4 });
  assert.equal(observed[1]?.focused, true);

  const ascii = view.render(context({
    width: 10,
    height: 6,
    theme: { name: "mono", color: false, unicode: false },
  }));
  assert.match(ascii.lines[0]?.spans.map((span) => span.text).join("") ?? "", /^\+/u);
});

test("component-kit views remain generation-owned when mounted by the host", () => {
  const generation = new AbortController();
  const mounted = RuntimeUiComponentMount.create(() => uiPanel(uiText("owned"), { title: "Host" }), {
    signal: generation.signal,
    requestRender() {},
  });

  assert.equal(mounted.render(context()).ok, true);
  generation.abort(new Error("reload"));
  assert.equal(mounted.closed, true);
  assert.equal(mounted.render(context()).ok, false);
});

test("component-kit validation rejects malformed shapes and unbounded output", () => {
  assert.throws(
    () => uiText("x", { role: "rawAnsi" } as never),
    /role is invalid/u,
  );
  assert.throws(
    () => uiText("x", { escape: "raw" } as never),
    /unknown keys: escape/u,
  );
  assert.throws(
    () => uiPanel(uiText("x"), { padding: 2 } as never),
    /padding must be 0 or 1/u,
  );
  assert.throws(
    () => uiMarkdown("x".repeat(256 * 1024 + 1)),
    /exceeds 262144 bytes/u,
  );
  assert.throws(
    () => uiStack(Array.from({ length: 129 }, () => uiText("x"))),
    /exceeds 128 children/u,
  );

  const hostile = uiStack([{
    render: () => ({ lines: Array.from({ length: 129 }, () => ({ spans: [{ text: "x" }] })) }),
  }]);
  assert.throws(
    () => hostile.render(context()),
    /exceeds 128 lines/u,
  );
});

test("stack clips a child that ignores its visible height and marks omitted rows", () => {
  const view = uiStack([{
    render: () => ({
      lines: Array.from({ length: 10 }, (_, index) => ({ spans: [{ text: `line-${index}` }] })),
      cursor: { row: 9, column: 1 },
    }),
  }], { maxLines: 2 });
  const rendered = view.render(context({ width: 12, height: 10 }));

  assert.deepEqual(rendered.lines, [
    { spans: [{ text: "line-0" }] },
    { spans: [{ text: "…", role: "muted" }] },
  ]);
  assert.equal(rendered.cursor, undefined);
});
