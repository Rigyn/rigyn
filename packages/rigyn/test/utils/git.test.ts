import assert from "node:assert/strict";
import test from "node:test";

import { parseGitUrl } from "../../src/utils/git.js";

test("Git package syntax normalizes supported transports without guessing local paths", () => {
  const cases = [
    ["https://github.com/team/project", "https://github.com/team/project", undefined],
    ["ssh://git@github.com/team/project", "ssh://git@github.com/team/project", undefined],
    ["git:git@github.com:team/project", "git@github.com:team/project", undefined],
    ["git:github.com/team/project", "https://github.com/team/project", undefined],
    ["git:git@github.com:team/project@release-1", "git@github.com:team/project", "release-1"],
    ["git:https://github.com/team/project#release-2", "https://github.com/team/project", "release-2"],
    ["git:git@github.com:team/project#0123456789abcdef0123456789abcdef01234567", "git@github.com:team/project", "0123456789abcdef0123456789abcdef01234567"],
  ] as const;

  for (const [source, repository, ref] of cases) {
    const parsed = parseGitUrl(source);
    assert.ok(parsed, source);
    assert.equal(parsed.host, "github.com");
    assert.equal(parsed.path, "team/project");
    assert.equal(parsed.repo, repository);
    assert.equal(parsed.ref, ref);
    assert.equal(parsed.pinned, ref !== undefined && /^[a-f0-9]{40}$/u.test(ref));
  }

  assert.equal(parseGitUrl("git@github.com:team/project"), undefined);
  assert.equal(parseGitUrl("github.com/team/project"), undefined);
});

test("equivalent Git transports share one package identity", () => {
  const sources = [
    "git:git@github.com:team/project",
    "https://github.com/team/project",
    "ssh://git@github.com/team/project",
  ];
  const identities = sources.map((source) => {
    const parsed = parseGitUrl(source);
    assert.ok(parsed);
    return `git:${parsed.host}/${parsed.path}`;
  });
  assert.deepEqual(new Set(identities), new Set(["git:github.com/team/project"]));
});

test("Git package locations reject encoded or literal install-root escapes", () => {
  for (const source of [
    "https://github.com/team/../project",
    "https://github.com/team/%2e%2e/project",
    "git:github.com/team/..%2fproject",
    "git:github.com/team\\project",
  ]) {
    assert.equal(parseGitUrl(source), undefined, source);
  }
});
