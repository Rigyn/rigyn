import { readFile } from "node:fs/promises";

import { gt, lte, valid } from "semver";

import type { SettingsManager } from "../core/settings-manager.js";
import { RIGYN_VERSION } from "../version.js";

export interface ChangelogRelease {
  version: string;
  markdown: string;
}

export interface StartupChangelogPlan {
  recordVersion: string;
  notice?: string;
}

export interface StartupChangelogInput {
  changelog: string;
  currentVersion: string;
  previousVersion: string | undefined;
  collapse: boolean;
}

const RELEASE_HEADING = /^## \[([^\]]+)\](?:\s+-\s+.*)?$/gmu;

/** Extract released version sections without treating Unreleased as a release. */
export function parseChangelog(markdown: string): ChangelogRelease[] {
  const matches = [...markdown.matchAll(RELEASE_HEADING)];
  return matches.flatMap((match, index) => {
    const version = valid(match[1]);
    if (version === null || match.index === undefined) return [];
    const end = matches[index + 1]?.index ?? markdown.length;
    return [{ version, markdown: markdown.slice(match.index, end).trim() }];
  });
}

export function planStartupChangelog(input: StartupChangelogInput): StartupChangelogPlan {
  const current = valid(input.currentVersion);
  const previous = input.previousVersion === undefined ? null : valid(input.previousVersion);
  if (current === null || previous === null || !gt(current, previous)) {
    return { recordVersion: input.currentVersion };
  }
  const releases = parseChangelog(input.changelog)
    .filter((release) => gt(release.version, previous) && lte(release.version, current));
  if (releases.length === 0) return { recordVersion: input.currentVersion };
  return {
    recordVersion: input.currentVersion,
    notice: input.collapse
      ? `Rigyn updated to ${input.currentVersion}. Run /changelog for full release notes.`
      : releases.map((release) => release.markdown).join("\n\n"),
  };
}

export async function readPackageChangelog(): Promise<string> {
  return await readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
}

/** Persist the observed package version before returning any one-time startup notice. */
export async function updateStartupChangelog(
  settings: SettingsManager,
  changelog: string,
  currentVersion: string,
): Promise<string | undefined> {
  const plan = planStartupChangelog({
    changelog,
    currentVersion,
    previousVersion: settings.getLastChangelogVersion(),
    collapse: settings.getCollapseChangelog(),
  });
  if (settings.getLastChangelogVersion() !== plan.recordVersion) {
    settings.setLastChangelogVersion(plan.recordVersion);
    await settings.flush();
  }
  return plan.notice;
}

export async function presentStartupChangelog(
  settings: SettingsManager,
  notify: (message: string) => void,
): Promise<void> {
  const notice = await updateStartupChangelog(settings, await readPackageChangelog(), RIGYN_VERSION);
  if (notice !== undefined) notify(notice);
}
