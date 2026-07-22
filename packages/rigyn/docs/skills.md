# Skills

Skills are progressively disclosed instruction packages. Rigyn initially exposes each skill's name and description; the complete `SKILL.md` body is loaded only when the task calls for it or the user invokes its slash command. This keeps unrelated procedure text out of the active context.

## Directory shape

Each skill lives in its own directory:

```text
skills/
  release-check/
    SKILL.md
    checklist.md
```

`SKILL.md` starts with YAML frontmatter:

```markdown
---
name: release-check
description: Verify a release candidate and report blocking defects.
license: MIT
compatibility: Requires the repository test toolchain.
allowed-tools: read,bash
disable-model-invocation: false
---

# Release check

Read `checklist.md`, run the bounded checks, and report failures with evidence.
```

`name` and `description` are required. The name is short, stable, and must match the skill directory convention. Optional metadata describes licensing, environment assumptions, intended tools, and whether the model may select the skill without an explicit user invocation.

## Discovery

User skills live below the agent data directory. Project skills may live under trusted project resource roots, including `WORKSPACE/.rigyn/skills`. Packages can declare skill directories, and extensions can return package-relative `skillPaths` from `resources_discover`. `--skill PATH` adds an invocation-only file or directory; `--no-skills` disables automatic discovery.

Ignore files apply while walking skill roots. Hidden files and nested `SKILL.md` files are not automatically treated as separate skills unless their directories are themselves discovered roots. Name collisions are diagnosed with both the winning and losing paths.

## Authoring guidance

Keep the description specific enough to make selection reliable. Put the mandatory workflow in `SKILL.md`; route to supporting files by relative name and avoid copying large reference material into the manifest. State observable completion checks. A skill can guide tool use but cannot expand the active tool set, bypass project trust, or grant filesystem authority.

Inspect discoverability with `rigyn extensions doctor` and exercise both explicit invocation and a task that should trigger the description.
