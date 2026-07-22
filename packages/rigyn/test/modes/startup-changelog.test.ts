import assert from "node:assert/strict";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import {
  parseChangelog,
  planStartupChangelog,
  presentStartupChangelog,
  readPackageChangelog,
  updateStartupChangelog,
} from "../../src/modes/startup-changelog.js";
import { RIGYN_VERSION } from "../../src/version.js";

const CHANGELOG = `# Changelog

## Unreleased

### Added

- Work in progress.

## [2.1.0] - 2026-07-21

### Added

- New command.

## [2.0.1] - 2026-07-20

### Fixed

- Fixed a crash.

## [2.0.0] - 2026-07-19

### Changed

- Initial stable behavior.
`;

test("changelog parsing identifies semantic release sections and excludes Unreleased", () => {
  assert.deepEqual(parseChangelog(CHANGELOG), [
    {
      version: "2.1.0",
      markdown: "## [2.1.0] - 2026-07-21\n\n### Added\n\n- New command.",
    },
    {
      version: "2.0.1",
      markdown: "## [2.0.1] - 2026-07-20\n\n### Fixed\n\n- Fixed a crash.",
    },
    {
      version: "2.0.0",
      markdown: "## [2.0.0] - 2026-07-19\n\n### Changed\n\n- Initial stable behavior.",
    },
  ]);
});

test("a first startup records the installed version without replaying release history", () => {
  assert.deepEqual(planStartupChangelog({
    changelog: CHANGELOG,
    currentVersion: "2.1.0",
    previousVersion: undefined,
    collapse: false,
  }), {
    recordVersion: "2.1.0",
  });
});

test("startup persists its marker globally and returns a notice only once", async () => {
  const settings = SettingsManager.inMemory();
  assert.equal(await updateStartupChangelog(settings, CHANGELOG, "2.1.0"), undefined);
  assert.equal(settings.getLastChangelogVersion(), "2.1.0");
  assert.equal(await updateStartupChangelog(settings, CHANGELOG, "2.1.0"), undefined);
});

test("the packaged changelog records a fresh startup silently", async () => {
  const settings = SettingsManager.inMemory();
  const notifications: string[] = [];
  await presentStartupChangelog(settings, (message) => notifications.push(message));
  assert.equal(settings.getLastChangelogVersion(), RIGYN_VERSION);
  assert.deepEqual(notifications, []);
  assert.equal(parseChangelog(await readPackageChangelog()).some((release) => release.version === RIGYN_VERSION), true);
});

test("an update displays only releases newer than the recorded version", () => {
  assert.deepEqual(planStartupChangelog({
    changelog: CHANGELOG,
    currentVersion: "2.1.0",
    previousVersion: "2.0.0",
    collapse: false,
  }), {
    recordVersion: "2.1.0",
    notice: [
      "## [2.1.0] - 2026-07-21\n\n### Added\n\n- New command.",
      "## [2.0.1] - 2026-07-20\n\n### Fixed\n\n- Fixed a crash.",
    ].join("\n\n"),
  });
});

test("collapsed startup uses one concise notice while the parsed full history remains available", () => {
  const result = planStartupChangelog({
    changelog: CHANGELOG,
    currentVersion: "2.1.0",
    previousVersion: "2.0.1",
    collapse: true,
  });
  assert.deepEqual(result, {
    recordVersion: "2.1.0",
    notice: "rigyn updated to 2.1.0. Run /changelog for full release notes.",
  });
  assert.equal(parseChangelog(CHANGELOG).length, 3);
});

test("same-version, downgrade, and malformed-version starts do not replay entries", () => {
  for (const previousVersion of ["2.1.0", "3.0.0", "not-a-version"]) {
    assert.deepEqual(planStartupChangelog({
      changelog: CHANGELOG,
      currentVersion: "2.1.0",
      previousVersion,
      collapse: false,
    }), { recordVersion: "2.1.0" });
  }
});
