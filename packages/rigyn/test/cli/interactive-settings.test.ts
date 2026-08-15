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

test("interactive settings use signal when no theme is configured", () => {
  const settings = SettingsManager.inMemory();
  const session = {
    autoCompactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    thinkingLevel: "medium",
    getAvailableThinkingLevels: () => ["off", "medium"],
  } as unknown as Pick<AgentSession,
    "autoCompactionEnabled" | "steeringMode" | "followUpMode" | "thinkingLevel" |
    "getAvailableThinkingLevels">;

  const theme = interactiveSettingItems(settings, session, ["mono", "signal"])
    .find((item) => item.id === "theme");
  assert.equal(theme?.value, "signal");
});

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

  const items = interactiveSettingItems(settings, session, ["mono", "ocean", "signal"]);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (const item of items) assert.equal(item.values.includes(item.value), true, item.id);
  assert.deepEqual(items.map((item) => item.id), [
    "auto-compact",
    "compaction-trigger",
    "thinking-level",
    "steering-mode",
    "follow-up-mode",
    "transport",
    "http-idle-timeout",
    "show-images",
    "image-width",
    "auto-resize-images",
    "block-images",
    "skill-commands",
    "theme",
    "cache-miss-notices",
    "collapse-changelog",
    "double-escape",
    "tree-filter",
    "hardware-cursor",
    "editor-padding",
    "output-padding",
    "autocomplete-rows",
    "quiet-startup",
    "project-trust",
    "clear-on-shrink",
    "terminal-progress",
    "anthropic-usage-warning",
  ]);
  assert.equal(items.some((item) => item.id === "install-telemetry"), false);
  assert.deepEqual(items.find((item) => item.id === "theme")?.values, ["mono", "ocean", "signal"]);
  assert.match(items.find((item) => item.id === "transport")?.description ?? "", /refresh/u);
  assert.match(items.find((item) => item.id === "http-idle-timeout")?.description ?? "", /refresh/u);
  assert.equal(items.find((item) => item.id === "transport")?.value, "auto");
  assert.equal(items.find((item) => item.id === "steering-mode")?.value, "one-at-a-time");
  assert.equal(items.find((item) => item.id === "follow-up-mode")?.value, "one-at-a-time");
  assert.equal(items.find((item) => item.id === "terminal-progress")?.value, "off");
  assert.equal(items.find((item) => item.id === "compaction-trigger")?.value, "85");
  assert.equal(items.find((item) => item.id === "compaction-trigger")?.values.includes("95"), true);
  assert.deepEqual(items.filter((item) => item.id.startsWith("theme")).map((item) => item.id), ["theme"]);

  applyInteractiveSetting({ id: "auto-compact" }, "off", settings, session, terminal);
  applyInteractiveSetting({ id: "compaction-trigger" }, "90", settings, session, terminal);
  applyInteractiveSetting({ id: "transport" }, "websocket-cached", settings, session, terminal);
  applyInteractiveSetting({ id: "theme" }, "ocean", settings, session, terminal);
  applyInteractiveSetting({ id: "http-idle-timeout" }, "1800000", settings, session, terminal);
  applyInteractiveSetting({ id: "auto-resize-images" }, "off", settings, session, terminal);
  applyInteractiveSetting({ id: "collapse-changelog" }, "on", settings, session, terminal);
  applyInteractiveSetting({ id: "hardware-cursor" }, "off", settings, session, terminal);
  applyInteractiveSetting({ id: "editor-padding" }, "2", settings, session, terminal);
  applyInteractiveSetting({ id: "output-padding" }, "0", settings, session, terminal);
  applyInteractiveSetting({ id: "autocomplete-rows" }, "10", settings, session, terminal);
  applyInteractiveSetting({ id: "quiet-startup" }, "on", settings, session, terminal);
  applyInteractiveSetting({ id: "clear-on-shrink" }, "on", settings, session, terminal);
  applyInteractiveSetting({ id: "anthropic-usage-warning" }, "off", settings, session, terminal);
  applyInteractiveSetting({ id: "double-escape" }, "fork", settings, session, terminal);

  assert.equal(settings.getCompactionEnabled(), false);
  assert.equal(settings.getCompactionTriggerPercent(), 90);
  assert.equal(settings.getTransport(), "websocket-cached");
  assert.equal(agent.transport, "auto");
  assert.equal(settings.getThemeSetting(), "ocean");
  assert.equal(settings.getHttpIdleTimeoutMs(), 1_800_000);
  assert.equal(settings.getImageAutoResize(), false);
  assert.equal(settings.getCollapseChangelog(), true);
  assert.equal(settings.getShowHardwareCursor(), false);
  assert.equal(settings.getEditorPaddingX(), 2);
  assert.equal(settings.getOutputPad(), 0);
  assert.equal(settings.getAutocompleteMaxVisible(), 10);
  assert.equal(settings.getQuietStartup(), true);
  assert.equal(settings.getClearOnShrink(), true);
  assert.equal(settings.getWarnings().anthropicExtraUsage, false);
  assert.equal(settings.getDoubleEscapeAction(), "fork");
  assert.deepEqual(calls, ["compact:false"]);
  assert.deepEqual(terminalCalls, [
    "theme:ocean",
    "preferences",
    "preferences",
    "preferences",
    "preferences",
    "preferences",
    "escape:fork",
  ]);
  assert.equal(tuiOperatorPreferences(settings).editorPaddingX, 2);
  assert.equal(tuiOperatorPreferences(settings).outputPad, 0);
  assert.equal(tuiOperatorPreferences(settings).autocompleteMaxVisible, 10);
  assert.equal(tuiOperatorPreferences(settings).showHardwareCursor, false);
  assert.equal(tuiOperatorPreferences(settings).clearOnShrink, true);
  assert.equal(tuiOperatorPreferences(settings).fullscreenScrollbar, "auto");

  assert.throws(
    () => applyInteractiveSetting({ id: "compaction-trigger" }, "96", settings, session, terminal),
    /integer from 50 through 95/u,
  );
  assert.throws(
    () => applyInteractiveSetting({ id: "editor-padding" }, "9", settings, session, terminal),
    /integer from 0 through 3/u,
  );
  assert.throws(
    () => applyInteractiveSetting({ id: "http-idle-timeout" }, "2147483648", settings, session, terminal),
    /integer from 0 through 2147483647/u,
  );
  assert.throws(
    () => applyInteractiveSetting({ id: "unknown" }, "on", settings, session, terminal),
    /Unknown interactive setting/u,
  );
});

test("automatic theme pairs remain one settings row", () => {
  const settings = SettingsManager.inMemory({ theme: "paper/ocean" });
  const session = {
    autoCompactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    thinkingLevel: "medium",
    getAvailableThinkingLevels: () => ["off", "medium"],
  } as unknown as Pick<AgentSession,
    "autoCompactionEnabled" | "steeringMode" | "followUpMode" | "thinkingLevel" |
    "getAvailableThinkingLevels">;

  const themeItems = interactiveSettingItems(settings, session, ["mono", "ocean", "paper", "signal"])
    .filter((item) => item.id.startsWith("theme"));

  assert.equal(themeItems.length, 1);
  assert.equal(themeItems[0]?.id, "theme");
  assert.equal(themeItems[0]?.value, "paper/ocean");
  assert.equal(themeItems[0]?.values.includes("paper/ocean"), true);
  assert.equal(themeItems[0]?.values.includes("signal"), true);
});
