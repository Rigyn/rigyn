# Session export

Rigyn stores each conversation as an append-only version 3 JSONL tree. An HTML export is a self-contained, offline viewer for that tree; it is not a second session database.

## Create an export

Inside the interactive terminal:

```text
/export conversation.html
```

Use a `.jsonl` destination to make a machine-readable copy instead:

```text
/export conversation.jsonl
```

Create a redacted copy intended for manual review before sharing:

```text
/share conversation.html
/export --redact conversation.jsonl
```

From a shell, convert an existing session without starting a provider runtime:

```sh
rigyn --export path/to/session.jsonl conversation.html
rigyn --export path/to/session.jsonl conversation.html --redact
```

`AgentSession.exportToHtml(outputPath?, { redact })`, `AgentSession.exportToJsonl(outputPath?, { redact })`, `renderSessionHtml()`, and `exportSessionFile()` expose the same formats to embedded callers. Export files are owner-readable (`0600`) on systems that support Unix permission bits.

## What the HTML contains

The viewer embeds its styles, program, and UTF-8 session payload. It does not fetch a script, stylesheet, font, or rendering service. It includes:

- the complete JSONL entry graph, including multiple roots, labels, branch summaries, compactions, custom entries, model and thinking changes;
- branch navigation, active-path highlighting, deep links, search, and tree filters;
- user, assistant, system, custom, shell, tool-call, and tool-result rows;
- stored images, reasoning-shaped provider blocks, ANSI terminal rows, and preserved whitespace;
- historical input, output, cache-read, cache-write, and recorded cost totals across every branch;
- the active system prompt, tool schemas, skill inventory, and extension tool presentation when exported from a live `AgentSession`;
- a button that downloads the exact original JSONL bytes for ordinary exports, or the regenerated redacted JSONL for redacted exports.

Tool results and structural details use native collapsed/expanded controls. Tools and thinking can also be hidden globally. The session-tree width is stored locally in the browser and is clamped to a safe range. The navigation becomes an overlay on narrow screens.

When an arbitrary JSONL file is converted from the shell, live-only metadata may be unavailable. Rigyn derives a stored instruction prompt when possible and always uses the safe generic tool renderer. The conversation tree and stored content are unaffected.

An unavailable or invalid presentation theme falls back to Rigyn's built-in dark export theme. The built-in light theme is preserved when it is active.

## JSONL copy

`AgentSession.exportToJsonl(outputPath?)` writes the active live session to a new file. Each non-empty line is one complete JSON object. The first record is the version 3 session header and later records are append-only entries.

The copy retains IDs, ancestry, timestamps, model selections, summaries, extension entries, tool content, images, provider state, and stored usage. It is the round-trip representation; HTML is for reading and inspection.

## Security and privacy

An export is private data. It can contain source code, local paths, prompts, tool output, pasted credentials, personal information, and extension-authored content. Inspect it before sharing it.

The viewer treats every session field as data. Session values are carried in a base64-encoded JSON payload and inserted with DOM text operations rather than HTML interpolation. Markdown-like HTML stays visible as text. Links and images use a positive scheme and media allowlist after C0 controls are stripped. Entry identifiers are mapped to generated DOM positions, and a restrictive content-security policy blocks external scripts, forms, base URLs, and other active content.

These protections prevent session text from becoming viewer code; they do not redact sensitive information. Rigyn does not upload an export automatically, and an ordinary export is not share-safe anonymization.

`/share`, `/export --redact`, and shell `--redact` remove registered credentials, recognized token formats, authorization values, and values under common secret-bearing keys from the exported header, entries, prompt metadata, rendered tool data, and downloadable JSONL. Redaction is intentionally described as review-required: it cannot infer every private value, source fragment, personal identifier, or novel credential format. Inspect the result before sharing it.
