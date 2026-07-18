import assert from "node:assert/strict";
import { access, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import activate from "./runtime/index.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rigyn-approval-example-"));
  const path = join(root, ".rigyn-approval-example");
  await writeFile(path, "example");
  t.after(() => rm(root, { recursive: true, force: true }));
  let tool;
  activate({ registerTool(value) { tool = value; } });
  return { root, path, tool };
}

function context(root, overrides = {}) {
  return {
    workspace: { root },
    signal: new AbortController().signal,
    hasUI: false,
    mode: "headless",
    ui: { async confirm() { throw new Error("must not prompt headlessly"); } },
    ...overrides,
  };
}

test("approval gate fails closed without interactive UI", async (t) => {
  const { root, path, tool } = await fixture(t);
  const result = await tool.execute({}, context(root));
  assert.equal(result.status, "error");
  await access(path);
});

test("approval gate preserves a declined action and executes an approved action", async (t) => {
  const { root, path, tool } = await fixture(t);
  const declined = await tool.execute({}, context(root, {
    hasUI: true,
    mode: "interactive",
    ui: { async confirm() { return false; } },
  }));
  assert.equal(declined.status, "warning");
  await access(path);

  const accepted = await tool.execute({}, context(root, {
    hasUI: true,
    mode: "interactive",
    ui: { async confirm() { return true; } },
  }));
  assert.equal(accepted.status, "success");
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
});

test("approval gate preserves the marker when cancellation arrives after confirmation", async (t) => {
  const { root, path, tool } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(tool.execute({}, context(root, {
    signal: controller.signal,
    hasUI: true,
    mode: "interactive",
    ui: {
      async confirm() {
        controller.abort(new Error("cancel approved action"));
        return true;
      },
    },
  })), /cancel approved action/u);
  await access(path);
});

test("approval gate rejects a replaced or removed approved snapshot", async (t) => {
  const replaced = await fixture(t);
  const replacement = join(replaced.root, "replacement");
  await writeFile(replacement, "example");
  const stale = await replaced.tool.execute({}, context(replaced.root, {
    hasUI: true,
    mode: "interactive",
    ui: {
      async confirm() {
        await unlink(replaced.path);
        await rename(replacement, replaced.path);
        return true;
      },
    },
  }));
  assert.equal(stale.status, "error");
  assert.equal(stale.summary, "The approved file snapshot is stale.");
  await access(replaced.path);

  const removed = await fixture(t);
  const missing = await removed.tool.execute({}, context(removed.root, {
    hasUI: true,
    mode: "interactive",
    ui: {
      async confirm() {
        await unlink(removed.path);
        return true;
      },
    },
  }));
  assert.equal(missing.status, "error");
  assert.equal(missing.summary, "The approved file snapshot is stale.");
});
