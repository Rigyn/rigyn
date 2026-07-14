import { RIGYN_VERSION } from "../version.js";

const header = `Rigyn ${RIGYN_VERSION} — coding agent with read, bash, edit, and write tools`;

const GLOBAL = `${header}

Usage:
  rigyn [OPTIONS] [@FILES...] [MESSAGES...]

Commands:
  rigyn install SOURCE [-l]      Install a package; add --allow-scripts only after review
  rigyn remove SOURCE [-l]       Remove an installed package
  rigyn update [SOURCE] [--all]  Update one or all installed packages
  rigyn list                     List installed packages
  rigyn packages check           Check the trusted project declaration and immutable lock
  rigyn packages update --all    Intentionally resolve, lock, and reconcile project packages
  rigyn extensions doctor        Diagnose discovered extension resources
  rigyn extensions author report Verify a local extension package without installing it
  rigyn sessions doctor          Check the complete session database and references
  rigyn sessions repair --reindex --yes
                                        Back up and rebuild corrupt SQLite indexes
  rigyn diagnostics [FILE]       Create a local redacted support bundle
  rigyn config [-l]              Configure package resources
  rigyn self-install             Install a self-contained user copy
  rigyn self-update              Update the self-contained user copy
  rigyn uninstall --yes          Remove the product and saved state
  rigyn rpc [OPTIONS]             Start newline-delimited JSON RPC mode
  rigyn COMMAND --help           Show command-specific help

Model:
      --provider NAME       Provider name
  -m, --model PATTERN       Model ID or provider/model pattern
      --api-key KEY         API key for this invocation; not persisted
      --models PATTERNS     Comma-separated model patterns for model cycling
      --thinking LEVEL      off|minimal|low|medium|high|xhigh|max

Sessions:
  -c, --continue            Continue the most recent project session
  -r, --resume              Select a session to resume
      --all                 With continue/resume/session, search every indexed workspace
      --session REF         Resume a session by exact or partial ID
      --session-id ID       Use this exact project session ID, creating it if needed
      --fork REF            Fork a saved session
      --workspace DIR       Use DIR as the project workspace (default: current directory)
      --session-dir DIR     Store and find sessions under DIR
      --no-session          Do not save this session
  -n, --name NAME           Set the session display name

Tools and resources:
  -t, --tools LIST          Comma-separated tool allowlist
  -nt, --no-tools           Disable all built-in and extension tools
  -nbt, --no-builtin-tools  Disable built-ins; keep extension tools enabled
  -xt, --exclude-tools LIST Disable selected tools
  -e, --extension PATH      Load an extension; repeatable
      --package SOURCE      Load a package for this run only; repeatable
      --allow-scripts       Run reviewed dependency lifecycle scripts for this package transaction
  -ne, --no-extensions      Disable automatic extension discovery
      --skill PATH          Load a skill file or directory; repeatable
  -ns, --no-skills          Disable automatic skill discovery
      --prompt-template PATH  Load a prompt template file or directory; repeatable
  -np, --no-prompt-templates  Disable automatic prompt discovery
      --theme PATH          Load a theme file or directory; repeatable
      --no-themes           Disable automatic theme discovery
  -nc, --no-context-files   Disable project instruction-file discovery

Other:
  -p, --print               Process messages non-interactively and exit
      --mode MODE           Output mode: text (default), json, or rpc
      --list-models [TEXT]  List models from connected providers and exit
      --export FILE         Export the selected or latest session and exit
  -a, --approve             Trust project-local resources for this invocation
  -na, --no-approve         Ignore project-local resources for this invocation
      --offline             Skip startup network refreshes
      --verbose             Show expanded startup details
  -h, --help                Show this help
  -v, --version             Show version

Examples:
  rigyn
  rigyn "Read package.json and explain the scripts"
  rigyn @issue.md "Implement this change"
  rigyn -p "List all TypeScript files under src"
  rigyn --continue "Continue the previous task"
  rigyn --continue --all --workspace ~/another-project "Continue my latest saved task"
  rigyn --model openai/gpt-5.4-mini:high "Fix the failing tests"
  rigyn --tools read,grep,find,ls -p "Review this repository"
`;

const PACKAGE_SOURCE = "SOURCE may be a local directory, npm:SPEC, or an HTTPS/SSH Git repository. Git refs may follow # or the repository path's final @.";

const COMMAND_HELP: Readonly<Record<string, string>> = Object.freeze({
  install: `${header}

Usage:
  rigyn install SOURCE [-l] [--allow-scripts]

Installs a package for the current user. Use -l to install it for the current project.
${PACKAGE_SOURCE}
Dependency lifecycle scripts remain disabled unless --allow-scripts is provided.
`,
  remove: `${header}

Usage:
  rigyn remove SOURCE [-l]

Removes an installed package. Use -l for the current project.
`,
  uninstall: `${header}

Usage:
  rigyn uninstall --yes
  rigyn self-uninstall --yes

Removes the marker-verified self-contained product installation, including its
saved configuration, credentials, sessions, cache, and managed command.
`,
  "self-install": `${header}

Usage:
  rigyn self-install

Builds or installs an independent per-user copy under ~/.rigyn without
linking it to the source checkout or using npm's global package directory.
`,
  "self-update": `${header}

Usage:
  rigyn self-update

Downloads the latest published Rigyn package and atomically replaces
the self-contained application while preserving user configuration and state.
`,
  "self-uninstall": `${header}

Usage:
  rigyn self-uninstall --yes

Alias for the marker-verified product uninstall command.
`,
  update: `${header}

Usage:
  rigyn update SOURCE [-l] [--allow-scripts]
  rigyn update --all [-l] [--allow-scripts]

--allow-scripts applies only to this update transaction's production dependencies.
`,
  list: `${header}

Usage:
  rigyn list [-l]
`,
  packages: `${header}

Usage:
  rigyn packages check [--approve]
  rigyn packages reconcile [--approve]
  rigyn packages update ID... [--approve]
  rigyn packages update --all [--approve]

Reads .rigyn/packages.json only after workspace trust. Update intentionally
resolves moving npm, Git, and approved local sources and atomically writes an
immutable lock. Reconcile installs only exact locked versions, revisions, and
digests; it never updates moving sources or enables lifecycle scripts.
`,
  extensions: `${header}

Usage:
  rigyn extensions [list|doctor|commands|prompts]
  rigyn extensions show ID
  rigyn extensions author validate|inspect|smoke|reload|report PACKAGE
  rigyn extensions author pack PACKAGE DESTINATION
  rigyn extensions author index GALLERY.json
  rigyn extensions install SOURCE [-l] [--allow-scripts]
  rigyn extensions remove ID [-l]
  rigyn extensions update ID [-l] [--allow-scripts]

Inspects discovered resources, verifies extension packages without installing them,
or delegates package management actions. Author checks use the same bounded package
staging and in-process public runtime loader as the host. Pack requires package.json.
Dependency lifecycle scripts remain disabled unless --allow-scripts is provided.
`,
  config: `${header}

Usage:
  rigyn config [-l]

Opens package resource configuration for user or project scope.
`,
  diagnostics: `${header}

Usage:
  rigyn diagnostics [FILE] [--workspace DIR]

Collects bounded local configuration/resource status and operation timings as
JSON. It never reads credential values or session content, and it omits
configuration values and resource bodies. When FILE is given, creation is
exclusive and owner-only; an existing file is never replaced.
`,
  sessions: `${header}

Usage:
  rigyn sessions doctor [--json] [--workspace DIR] [--session-dir DIR]
  rigyn sessions repair --reindex --yes [--json] [--workspace DIR] [--session-dir DIR]

Doctor performs SQLite's full integrity check and foreign-key check without
changing the database. Repair is limited to rebuilding indexes: it requires
explicit confirmation, creates an owner-only unique backup beside the database,
and commits only when the complete post-repair checks pass. Close every Rigyn
process before repair. Other corruption must be restored from backup.
`,
  rpc: `${header}

Usage:
  rigyn rpc [OPTIONS]

Starts newline-delimited JSON RPC over standard input and output. Automatic
resource discovery follows the same trust and invocation flags as interactive
mode; explicit --extension, --skill, --prompt-template, and --theme paths are
also supported.
`,
});

export function renderCliHelp(command?: string): string {
  if (command === undefined || command === "help" || command === "run" || command === "chat") return GLOBAL;
  const value = COMMAND_HELP[command];
  if (value === undefined) throw new Error(`Unknown help topic: ${command}`);
  return value;
}
