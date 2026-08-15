# Skills

A skill is a Markdown instruction package. rigyn discovers a skill by its name
and description. The base prompt contains only this metadata. rigyn adds the
skill body to a turn when the model reads the file or the operator uses the
skill command.

## Directory shape and frontmatter

The conventional layout is:

```text
skills/
  release-check/
    SKILL.md
    checklist.md
```

`SKILL.md` can begin with YAML frontmatter:

```markdown
---
name: release-check
description: Verify a release candidate and report blocking defects.
license: MIT
compatibility: Requires the repository test toolchain.
allowed-tools: read,bash
disable-model-invocation: false
metadata:
  owner: release-team
---

# Release check

Read `checklist.md`, run its checks, and report evidence.
```

The active runtime requires a non-empty string for `description`. If you omit
`name`, rigyn uses the name of the parent directory. A declared name should
contain no more than 64 characters. Use lowercase letters, digits, and single
hyphens between words. An invalid name produces a warning, but the skill still
loads. A description longer than 1,024 characters has the same behavior.
rigyn skips a skill when its description is missing or its YAML is malformed.

`disable-model-invocation: true` removes the skill from the base prompt's
skill catalog. It does not disable an explicit `/skill:NAME` command. The
runtime treats `license`, `compatibility`, `allowed-tools`, and `metadata` as
authoring metadata. These fields do not enable or restrict tools. A skill
cannot expand the active tool set. It cannot bypass project trust or grant
filesystem access.

## Active runtime roots

Automatic discovery can include:

- `$RIGYN_HOME/skills`;
- `WORKSPACE/.rigyn/skills`, after project approval;
- `~/.agents/skills`, `~/.claude/skills`, and `~/.codex/skills`;
- `.agents/skills` from the repository root through a trusted nested working
  directory, plus the trusted working directory's `.claude/skills` and
  `.codex/skills`;
- the single bundled `rigyn-dev` development skill;
- skill roots declared by enabled packages;
- paths returned by trusted extension `resources_discover` callbacks;
- settings paths and repeatable `--skill PATH` inputs.

When the working directory is the home directory, `~/.agents/skills`,
`~/.claude/skills`, and `~/.codex/skills` remain personal user roots. Their
presence does not trigger a project-trust prompt. The same directory names
inside another workspace remain project resources and require trust.

`--no-skills` disables automatic roots. Explicit `--skill` paths remain active.
Project roots, project settings, project packages, and shared workspace roots
remain inactive until you trust the project.

The active loader processes resource paths in precedence order. It keeps the
first definition of each skill name. A collision diagnostic records both
paths. The loader uses this high-level order:

1. invocation package resources;
2. declarative project package resources;
3. configured and automatic project roots, including shared project roots;
4. configured and automatic user roots, including shared user roots;
5. configured package resources;
6. the bundled `rigyn-dev` root;
7. explicit `--skill` paths.

The package manager uses this order within configured and conventional
resources: project configured, project automatic, user configured, user
automatic, and package-owned paths. rigyn loads canonically identical paths
only once.

rigyn sorts entries within each root and scans them in a stable order. A
directory that contains an eligible `SKILL.md` defines one skill. rigyn does
not scan below that directory. rigyn scans a directory without a manifest
recursively. Native roots accept direct top-level `*.md` skill files. Shared
compatibility roots do not. rigyn skips hidden entries and `node_modules`.

`.gitignore`, `.ignore`, and `.fdignore` rules apply while walking, including
later negation rules. An explicit manifest path bypasses recursive ignore
matching. The runtime canonicalizes visited directories to prevent duplicate
symlink traversal.

The active loader is permissive and follows eligible filesystem links. It
reads at most 1 MiB from each manifest, ignore file, and invoked skill body.
Programmatic loaders can lower this limit or raise it to at most 16 MiB with
`maxFileBytes`. Load only roots that you trust. Use the strict discovery API
when an untrusted caller selects the roots.

Skills supplied by a package with root `plugin.json` use a separate,
source-specific rule set. Only `skills/*/SKILL.md` is discovered; deeper skill
directories and top-level Markdown files are not scanned. These manifests must
contain valid frontmatter, a required name matching the immediate directory,
and a required description. Invalid candidates are skipped with stable
`PORTABLE_PLUGIN_*` diagnostics. rigyn validates the same constraints again
when the resource loader opens an accepted manifest. Native package, shared,
settings, and command-line skill roots retain the discovery behavior described
above.

## Invocation

When the `read` tool is active, the system prompt lists model-invocable skills.
Each entry contains an escaped name, a description, and an absolute manifest
path. The runtime does not prepare skill bodies. The model resolves referenced
files from the skill directory.

The operator form is:

```text
/skill:release-check optional task input
```

For a known skill, `AgentSession.prompt()` reads the current file and removes
its frontmatter. It wraps the body with the skill name and source location.
It then appends the optional task input. An unknown skill name remains literal.
A read failure produces a resource diagnostic and also leaves the input
literal. The low-level `sendUserMessage()` method does not expand prompt
templates or skills.

When `enableSkillCommands` is true, the interactive picker and slash completion
show each discovered skill as `skill:NAME`. If a prompt template has the same
name, those interactive surfaces show the shorter prompt command and omit the
redundant skill row. A directly entered `/skill:NAME` command still works.
When the setting is false, the two interactive surfaces hide all skill entries.
The setting does not unload a skill or remove model-visible metadata. RPC and
extension command introspection continue to report every invocable skill
command and do not use this interactive preference. To prevent a skill from
loading, use `--no-skills`, use resource filters, or remove its root.

## Strict discovery API

`discoverSkillsDetailed()` from `rigyn/context` is the strict validation API.
It enforces root boundaries for hosts that accept caller-selected roots. The
active runtime and the built-in diagnostic command do not use this API:

```ts
import {
  discoverSkillsDetailed,
  loadSkill,
  sharedUserSkillRoots,
  sharedWorkspaceSkillRoots,
} from "rigyn/context";

const result = await discoverSkillsDetailed([
  ...sharedUserSkillRoots(home),
  ...sharedWorkspaceSkillRoots(workspace, projectTrusted),
]);
```

By default, this API accepts at most 128 winning names. It reads at most 8 KiB
of frontmatter from each manifest. Both configured limits must be positive
safe integers. The API requires:

- YAML frontmatter beginning on the first line and ending with a `---` fence;
- a non-empty string `name` and `description`;
- a YAML mapping with unique keys and bounded aliases;
- a string-to-string `metadata` mapping;
- a boolean `disable-model-invocation` when supplied;
- string `license` and `allowed-tools` values when supplied;
- a `compatibility` string from 1 through 500 characters when supplied.

The API reports warnings for invalid name formats, name and directory
mismatches, descriptions longer than 1,024 characters, and unknown fields.
It reports errors for missing required values, malformed or truncated
frontmatter, invalid metadata, and mistyped invocation controls. An error
excludes only that candidate. Diagnostics use stable codes such as
`SKILL_FRONTMATTER_INVALID`, `SKILL_NAME_MISMATCH`,
`SKILL_METADATA_INVALID`, and `SKILL_COLLISION`.

Strict recursive discovery uses `WorkspaceBoundary` to enforce the declared
root. It rejects symlink escapes. Ignore files have a 1 MiB limit. The scanner
does not follow symlinked ignore files. A manifest at a directory root stops
recursion. Direct root Markdown is enabled by default. Set
`rootMarkdown: false` to disable it. An explicit manifest remains eligible
when recursive ignore rules would hide it.

The active loader keeps the first same-name skill. Strict discovery instead
lets a later root replace an earlier same-name skill. Its diagnostic reports
the winner and loser manifest and root paths. Preserve the root order that
your host requires. The shared-root helpers return:

```text
user:      ~/.agents/skills, ~/.claude/skills, ~/.codex/skills
workspace: repository-root-to-cwd .agents/skills,
           then cwd/.claude/skills and cwd/.codex/skills
```

The helpers return workspace roots only when `projectTrusted` is true.
Compatibility shared roots set `rootMarkdown: false`.

Discovery reads only bounded metadata. Call `loadSkill(metadata, maxBytes?)`
to load the body. This function verifies that the manifest still resolves to
the exact discovered path under the same root. It reads at most 64 KiB by
default. It returns the complete manifest text, including frontmatter. It also
returns `totalBytes` and `truncated`. The caller decides how to present or
apply the instructions.

## Diagnostics and authoring checks

Use:

```sh
rigyn extensions doctor
rigyn diagnostics ./support.json
```

The diagnostic scan uses the same permissive loader as the runtime. It uses a
stable scan order and keeps the first same-name skill. It scans enabled
resolved skill paths and the bundled `rigyn-dev` root. The resolved paths already
contain shared user roots and trusted shared workspace roots. It keeps the
order supplied to the loader.

The support bundle contains bounded names, paths, and structured diagnostics.
It does not contain skill bodies. When a name exists in more than one root,
inspect its collision paths and `/resources`.

Use `discoverSkillsDetailed()` when a host needs strict frontmatter, byte
limit, or root boundary validation. It uses different collision rules from the
runtime loader. Preserve the root order that the host expects.

For a new skill:

1. use one stable lowercase name and match the directory;
2. make the description specific enough to identify the triggering work;
3. keep mandatory procedure in `SKILL.md` and supporting material beside it;
4. resolve supporting paths relative to the skill directory;
5. state observable completion checks;
6. test explicit invocation and a task that should discover the description;
7. test with the intended trust state and root order.
