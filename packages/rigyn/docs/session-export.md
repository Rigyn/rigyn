# Session export

rigyn can export a session as a strict V4 JSONL journal or as a self-contained
HTML viewer.

## Create an export

Inside the interactive terminal:

```text
/export conversation.html
/export conversation.jsonl
/export --redact conversation.jsonl
```

`/share` creates a temporary redacted HTML file, uploads it as a secret GitHub
Gist, returns the URL, and removes the temporary file. It requires an
authenticated GitHub CLI:

```sh
gh auth login
```

Convert an existing durable session to HTML without starting a provider:

```sh
rigyn --export path/to/session.jsonl conversation.html
rigyn --export path/to/session.jsonl conversation.html --redact
```

Embedded callers can use:

- `AgentSession.exportToHtml(outputPath?, { redact })`
- `AgentSession.exportToJsonl(outputPath?, { redact })`
- `renderSessionHtml()`
- `exportSessionFile()`

File exports are published only after the complete output has been written to a
private same-directory staging file. The final file is owner-readable (`0600`)
on systems that support Unix permission bits. An export fails if its destination
already exists, including when that destination is a symbolic link; choose a new
path or remove the old export intentionally before retrying.

## JSONL contract

`AgentSession.exportToJsonl()` writes a new strict V4 journal for the selected
conversation branch. The result has:

- one V4 header;
- ordered V4 commit records;
- preserved conversation node IDs, ancestry, timestamps, selections,
  summaries, extension content, tool content, images, provider state, and
  stored usage;
- no open operation, pending queue, checkpoint, or tool-effect recovery state.

This is a **settled journal projection**. It can be opened and resumed as
conversation history. It cannot resume work that was in progress when the
export was created.

A redacted JSONL export is also a valid settled V4 journal. Structural IDs and
references remain stable. Recognized secrets are removed from payload fields.

To preserve the complete operation ledger, keep the original durable session
file. Do not copy it while another process is writing unless the host provides
a stable snapshot boundary.

## HTML contract

The HTML viewer embeds its style, program, and session payload. It does not
fetch scripts, stylesheets, fonts, or a rendering service.

An ordinary HTML export from a durable file embeds the exact original V4
journal bytes. A redacted HTML export embeds a regenerated, settled V4
journal.

The viewer includes:

- the complete exported conversation graph and selected path;
- labels, summaries, compactions, model and thinking changes, and extension
  content;
- user, assistant, system, shell, tool-call, and tool-result rows;
- stored images, reasoning-shaped provider blocks, ANSI rows, and preserved
  whitespace;
- historical token and recorded cost totals;
- branch navigation, deep links, search, and filters;
- the active system prompt, tool schemas, skills, and extension tool
  presentation when available.

The viewer evaluates every token counter independently. A successful metered
assistant or native summary with no usage makes the affected exact total
unavailable; failed, cancelled, or aborted no-usage attempts and hook-created
no-usage summaries do not. If some but not all contributing scopes report a
counter, the viewer labels its `*Reported` known sum as partial. A
provider-reported `totalTokens` remains exact despite an incomplete component split; otherwise a
total is derived only from a complete protocol-safe split. Recorded cost uses
the same exact or reported-partial labeling and is never inferred from absent
usage.

The session tree indents only real branch points, so a long linear conversation
remains a readable timeline. Tool calls and results start collapsed. Built-in
summaries show concise paths, commands, ranges, line counts, and byte counts;
expanded Write and Edit previews preserve real line breaks. Tool, reasoning,
provider, prompt, and schema bodies are materialized only when opened and use
explicit line, byte, and long-line bounds. Those display bounds do not alter the
embedded or downloadable journal.

Tools and thinking can be hidden globally. The viewer stores its sidebar width
locally and uses an overlay on narrow screens.

When shell conversion has no live runtime metadata, rigyn derives stored
metadata where possible and uses the safe generic tool renderer.

## Security and privacy

An export can contain source code, local paths, prompts, tool output, pasted
credentials, personal data, and extension-authored content. Inspect it before
sharing.

The viewer treats session values as data. It stores them in a base64-encoded
JSON payload and inserts text through DOM text operations. Session text is not
interpolated as HTML.

Links and images must pass explicit scheme and media allowlists after control
characters are removed. The viewer never fetches external images when opened:
embedded `data:` images remain available offline, while HTTP(S) image
references appear as bounded links and make a request only if deliberately
opened. Those links use no referrer and an isolated browsing context. A
restrictive content-security policy blocks external images, scripts, forms,
and base URLs inside the viewer.

These rules prevent session text from becoming viewer code. They do not make
the data anonymous.

`/share`, `/export --redact`, and shell `--redact` remove registered
credentials, recognized token formats, authorization values, and common
secret-bearing fields. Redaction still needs manual review. A secret Gist is
unlisted, not access-controlled; anyone with its URL can read it.
