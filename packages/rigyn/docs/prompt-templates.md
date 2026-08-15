# Prompt templates

A prompt template is a Markdown file exposed as a slash command. Use one for a
repeatable task whose full instructions should enter the conversation. Use a
skill when the instructions should load only on demand or need supporting
files.

## Locations and loading

Place user templates in the `prompts` folder under the agent data directory.
Place project templates in `WORKSPACE/.rigyn/prompts`. Project templates
require workspace trust.

A package can declare prompt paths in `package.json`. A direct extension can
return package-relative `promptPaths` from `resources_discover`.

The runtime reads at most 1 MiB from each template. Programmatic loaders can
set `maxFileBytes` from 1 byte through 16 MiB. An oversized template is skipped
with a resource diagnostic.

Pass `--prompt-template FILE_OR_DIRECTORY` for an invocation-only source. Use `--no-prompt-templates` to disable automatic discovery.

The file name becomes the command name. For example, `review.md` is invoked as `/review`.

```markdown
---
description: Review one area and return actionable findings
argument-hint: AREA [FOCUS]
---
Review $1. Focus on ${2:-correctness}. Read files before reporting findings.
```

```text
/review src/storage durability
```

## Arguments

Arguments split on whitespace. Single or double quotes preserve spaces.
Substitution runs once.

| Form | Meaning |
| --- | --- |
| `$1`, `$2` | One-indexed positional argument |
| `$ARGUMENTS` or `$@` | All arguments joined with spaces |
| `${2:-fallback}` | Positional argument or fallback text |
| `${ARGUMENTS:-fallback}` | All arguments or fallback text |
| `${@:2}` | Arguments from position two onward |
| `${@:2:3}` | Up to three arguments starting at position two |
| `{{promptDir}}` | Directory containing the template |

Quote an argument when one replacement must contain spaces. A replacement is
not expanded again.

## Precedence and safety

Discovery is deterministic, but duplicate command names are harder to audit.
Give package templates specific names. Inspect them with
`rigyn extensions prompts` or the runtime discovery catalog.

Treat project templates as untrusted instructions until the workspace is
approved. Invoking a template does not give it extra operating-system
authority.
