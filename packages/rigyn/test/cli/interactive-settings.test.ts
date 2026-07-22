import assert from "node:assert/strict";
import test from "node:test";

import {
  applyInteractiveSetting,
  interactiveSettingItems,
  tuiOperatorPreferences,
} from "../../src/cli/interactive-settings.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import type { AgentSession } from "../../src/service/agent-session.js";
import type { TuiController } from "../../src/tui/controller.js";

test("interactive settings expose current values and apply persistent and live changes", () => {
  const settings = SettingsManager.inMemory({
    theme: "mono",
    compaction: { enabled: true },
    terminal: { showImages: true, imageWidthCells: 60 },
    editorPaddingX: 0,
  });
  const calls: string[] = [];
  const agent = { transport: "auto" };
  const session = {
    agent,
    autoCompactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    thinkingLevel: "medium",
    getAvailableThinkingLevels: () => ["off", "medium", "high"],
    setAutoCompactionEnabled(value: boolean) { settings.setCompactionEnabled(value); calls.push(`compact:${value}`); },
    setSteeringMode(value: string) { settings.setSteeringMode(value as "all" | "one-at-a-time"); calls.push(`steering:${value}`); },
    setFollowUpMode(value: string) { settings.setFollowUpMode(value as "all" | "one-at-a-time"); calls.push(`follow-up:${value}`); },
    setThinkingLevel(value: string) { calls.push(`thinking:${value}`); },
  } as unknown as Pick<AgentSession,
    "agent" | "autoCompactionEnabled" | "steeringMode" | "followUpMode" | "thinkingLevel" |
    "getAvailableThinkingLevels" | "setAutoCompactionEnabled" | "setSteeringMode" | "setFollowUpMode" | "setThinkingLevel">;
  const terminalCalls: string[] = [];
  const terminal = {
    setTheme(value: string) { terminalCalls.push(`theme:${value}`); },
    setDoubleEscapeAction(value: string) { terminalCalls.push(`escape:${value}`); },
    setOperatorPreferences() { terminalCalls.push("preferences"); },
  } as unknown as Pick<TuiController, "setTheme" | "setDoubleEscapeAction" | "setOperatorPreferences">;

  const items = interactiveSettingItems(settings, session, ["mono", "ocean"]);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (const item of items) assert.equal(item.values.includes(item.value), true, item.id);
  assert.ok(items.length >= 20);
  assert.equal(items.some((item) => item.id === "install-telemetry"), false);
  assert.deepEqual(items.find((item) => item.id === "theme")?.values, ["mono", "ocean"]);

  applyInteractiveSetting({ id: "auto-compact" }, "off", settings, session, terminal);
  applyInteractiveSetting({ id: "transport" }, "websocket-cached", settings, session, terminal);
  applyInteractiveSetting({ id: "theme" }, "ocean", settings, session, terminal);
  applyInteractiveSetting({ id: "editor-padding" }, "2", settings, session, terminal);
  applyInteractiveSetting({ id: "double-escape" }, "fork", settings, session, terminal);

  assert.equal(settings.getCompactionEnabled(), false);
  assert.equal(settings.getTransport(), "websocket-cached");
  assert.equal(agent.transport, "auto");
  assert.equal(settings.getThemeSetting(), "ocean");
  assert.equal(settings.getEditorPaddingX(), 2);
  assert.equal(settings.getDoubleEscapeAction(), "fork");
  assert.deepEqual(calls, ["compact:false"]);
  assert.deepEqual(terminalCalls, ["theme:ocean", "preferences", "escape:fork"]);
  assert.equal(tuiOperatorPreferences(settings).editorPaddingX, 2);

  assert.throws(
    () => applyInteractiveSetting({ id: "editor-padding" }, "9", settings, session, terminal),
    /integer from 0 through 3/u,
  );
  assert.throws(
    () => applyInteractiveSetting({ id: "unknown" }, "on", settings, session, terminal),
    /Unknown interactive setting/u,
  );
});
