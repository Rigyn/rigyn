# Instruction and system-prompt files

rigyn supports three kinds of persistent prompt text:

- context instruction files add project or user guidance;
- `SYSTEM.md` replaces the built-in system prompt;
- `APPEND_SYSTEM.md` adds text to the selected system prompt.

These files are prompt text. They do not install code, approve a workspace,
enable tools, or widen filesystem and process authority.

## Interactive and CLI context discovery

The active runtime checks the agent data directory first. It then checks every
directory from the filesystem root to the launch working directory. It selects
at most one context file in each directory, using this order:

```text
AGENTS.override.md
AGENTS.OVERRIDE.MD
AGENTS.md
AGENTS.MD
CLAUDE.md
CLAUDE.MD
```

The Rigyn-home result appears first. Filesystem ancestors follow from the
least specific to the most specific directory. Instructions nearest the
working directory therefore appear last. If the Rigyn home is also an
ancestor, rigyn includes its selected file only once.

The first regular file found owns that directory's slot. An empty
higher-priority file adds no text, but it still suppresses lower-priority names
in the same directory. A directory with a candidate name is skipped. If a
candidate cannot be read, rigyn warns and tries the next name.

An override file therefore replaces the ordinary and fallback instruction
names in the same directory. It does not replace files selected in parent or
child directories.

Context files load before workspace approval. Treat their content as untrusted
prompt input. Approval allows eligible project resources to load, but it does
not give prompt text operating-system authority.

Automatic runtime discovery reads at most 1 MiB from each selected regular
file. Programmatic loaders can lower this limit or raise it to at most 16 MiB.
An oversized or unreadable file produces a warning and does not consume
unbounded memory. The byte limit is a resource boundary, not a content
sanitizer.

`--no-context-files` disables agent-directory and ancestor context files for
that invocation. It does not disable explicit `--system-prompt` or
`--append-system-prompt` values. It also does not suppress `SYSTEM.md` or
`APPEND_SYSTEM.md`.

## System prompt replacement and append files

The automatic base replacement candidates are:

```text
WORKSPACE/.rigyn/SYSTEM.md
$RIGYN_HOME/SYSTEM.md
```

The project file wins, but it is considered only after the workspace is
trusted. Otherwise the user file is used. Discovery is anchored at the launch
workspace and does not search ancestor directories.

Append discovery follows the same rule:

```text
WORKSPACE/.rigyn/APPEND_SYSTEM.md
$RIGYN_HOME/APPEND_SYSTEM.md
```

rigyn selects only one automatic append file. A trusted project file replaces
the global file; the two files are not combined.

`--system-prompt VALUE` takes priority over automatic `SYSTEM.md` discovery.
Repeatable `--append-system-prompt VALUE` arguments replace the automatic
append file. rigyn joins those values in argument order with a blank line
between them.

For either flag, an existing path is read as a UTF-8 file. Any other value is
used as literal text.

`DefaultResourceLoader` exposes corresponding programmatic inputs and
post-discovery hooks:

```ts
new DefaultResourceLoader({
  cwd,
  agentDir,
  systemPrompt,
  appendSystemPrompt,
  agentsFilesOverride(base) {
    return base;
  },
  systemPromptOverride(base) {
    return base;
  },
  appendSystemPromptOverride(base) {
    return base;
  },
});
```

Each explicit input replaces file discovery for its layer. Each override
callback receives the selected base view and can replace it. These callbacks
compose an application; they do not bypass project-file trust.

Prompt assembly uses this order:

1. selected replacement prompt, or the built-in prompt;
2. selected append text;
3. context instruction files, each with its source path;
4. discoverable skill metadata when the read tool is active;
5. the current working directory marker.

`/refresh` rereads these resources transactionally. A failed candidate leaves
the previous generation active.

## Bounded instruction discovery API

`discoverInstructions()` from `rigyn/context` is a boundary-aware API for SDK
and host authors. Its default filename order in each directory is:

```text
AGENTS.override.md
AGENTS.md
CLAUDE.md
```

The override name therefore suppresses the ordinary and fallback names in that
directory. The caller can replace the list with `filenames`, but every item
must be a simple filename without `/` or `\`.

Discovery order is:

1. optional in-memory `userInstructions`;
2. optional `userInstructionFile`;
3. one selected file per directory, from the filesystem root through `cwd`.

`cwd` must resolve inside `workspaceRoot`. File and directory paths pass
through filesystem boundaries. A symlink that leaves its declared boundary
fails the operation. Discovery still checks ancestors above the declared
workspace, but each ancestor uses its own boundary.

The default limits are 64 KiB per file and 256 KiB for the complete result.
`maxFileBytes` and `maxTotalBytes` must be positive safe integers. Truncation
stops at a valid UTF-8 boundary. Both the entry and aggregate result report it.

Embedded user text uses the aggregate budget but not the per-file budget.
`includeFiles: false` keeps only embedded `userInstructions` and skips
`userInstructionFile`.

Every result records source, user/workspace scope, trust metadata, bytes read,
total file bytes, and truncation. The caller supplies the workspace `trusted`
flag; discovery reports it but does not turn prompt text into executable
authority. `renderInstructions()` adds source and trust labels without changing
entry order.

```ts
import { discoverInstructions, renderInstructions } from "rigyn/context";

const instructions = await discoverInstructions({
  workspaceRoot,
  cwd,
  trusted: false,
  userInstructionFile: "/home/user/.rigyn/AGENTS.md",
});

const promptSection = renderInstructions(instructions);
```

## Bounded prompt-file helper

`discoverWorkspacePromptFiles()` is also exported from `rigyn/context`. This
strict helper is separate from the interactive resource loader:

- a trusted workspace `.rigyn/SYSTEM.md` wins over
  `globalDirectory/SYSTEM.md`;
- a trusted workspace `.rigyn/APPEND_SYSTEM.md` wins over
  `globalDirectory/APPEND_SYSTEM.md`;
- an untrusted workspace is never opened;
- each selected file must be at most 256 KiB, valid UTF-8, and free of NUL;
- a symlink must remain inside its workspace or global directory boundary.

`includeSystemPrompt: false` suppresses only the base replacement lookup.
Append lookup still runs. The append result is an array containing zero or one
selected source.

## Trust checklist

- Review ancestor instructions as well as the file in the current directory.
- Use `/resources` to inspect the active instruction-file paths.
- Keep secrets out of prompt files; they are provider-visible input.
- Treat a custom `SYSTEM.md` as a complete replacement, including any safety
  or tool guidance the application still needs.
- Do not treat project approval as content validation. It authorizes eligible
  project resources to load; it does not make their instructions correct.
- Use the bounded helpers when accepting roots or files selected by another
  component.
