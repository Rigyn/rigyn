# Prompt templates

A prompt template is a Markdown file exposed as a slash command. It is appropriate for a repeatable task whose complete instructions should enter the conversation. Use a skill instead when instructions should load only after discovery or need supporting files.

## Locations and loading

Place user templates under the agent data directory's `prompts` folder or project templates under `WORKSPACE/.rigyn/prompts`. Project templates require workspace trust. A package can declare prompt paths in `package.json`, and a direct extension can return package-relative `promptPaths` from `resources_discover`.

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

Arguments split on whitespace, with single or double quotes preserving spaces. Substitution is single-pass.

| Form | Meaning |
| --- | --- |
| `$1`, `$2` | One-indexed positional argument |
| `$ARGUMENTS` or `$@` | All arguments joined with spaces |
| `${2:-fallback}` | Positional argument or fallback text |
| `${ARGUMENTS:-fallback}` | All arguments or fallback text |
| `${@:2}` | Arguments from position two onward |
| `${@:2:3}` | Up to three arguments starting at position two |
| `{{promptDir}}` | Directory containing the template |

Quote at invocation time when one replacement must contain spaces. Template substitution does not recursively expand text produced by a replacement.

## Precedence and safety

Discovery is deterministic, but duplicate command names make behavior harder to audit. Give package templates specific names and inspect them with `rigyn extensions prompts` or the runtime discovery catalog. Treat project templates as untrusted instructions until the workspace is approved; a template does not gain extra operating-system authority by being invoked.
