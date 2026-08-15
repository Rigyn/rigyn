import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseArgs } from "../../src/cli/args.js";
import { renderShellCompletion } from "../../src/cli/completions.js";
import { renderCliHelp } from "../../src/cli/help.js";
import { parseManagementArguments } from "../../src/cli/management-args.js";
import {
  AGENT_CLI_OPTIONS,
  CLI_COMPLETION_SHELLS,
  EXTENSION_AUTHOR_COMMANDS,
  MANAGEMENT_CLI_COMMANDS,
  MANAGEMENT_CLI_OPTIONS,
  type CliOptionMetadata,
  type ManagementCliCommandMetadata,
} from "../../src/cli/metadata.js";

const CLI_SOURCE = resolve("src/bin/rigyn.ts");
const agentOptions: readonly CliOptionMetadata[] = AGENT_CLI_OPTIONS;
const managementOptions: readonly CliOptionMetadata[] = MANAGEMENT_CLI_OPTIONS;
const managementCommands: readonly ManagementCliCommandMetadata[] = MANAGEMENT_CLI_COMMANDS;

function cli(args: readonly string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_SOURCE, ...args], {
    cwd: resolve("."),
    env: { ...process.env, RIGYN_RECURSION_DEPTH: "0", ...overrides },
    encoding: "utf8",
    timeout: 10_000,
  });
}

function assertBalancedQuotes(script: string): void {
  for (const [index, line] of script.split("\n").entries()) {
    let single = false;
    let double = false;
    let escaped = false;
    for (const character of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && !single) {
        escaped = true;
        continue;
      }
      if (character === "'" && !double) single = !single;
      else if (character === '"' && !single) double = !double;
    }
    assert.equal(single, false, `unclosed single quote on line ${index + 1}`);
    assert.equal(double, false, `unclosed double quote on line ${index + 1}`);
  }
}

function occurrences(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function optionValue(name: string, values: readonly string[] | undefined): string {
  if (values?.[0] !== undefined) return values[0];
  if (name === "max-steps" || name === "max-output-tokens" || name === "port") return "1";
  return "fixture";
}

test("completion metadata is the option and management parser authority", () => {
  for (const option of agentOptions) {
    for (const token of [option.long, ...(option.short === undefined ? [] : [option.short])]) {
      const parsed = parseArgs([
        token,
        ...(option.value === undefined ? [] : [optionValue(option.name, option.values)]),
      ]);
      assert.equal(parsed.unknownFlags.size, 0, token);
      assert.doesNotMatch(parsed.diagnostics.map((entry) => entry.message).join("\n"), /Unknown option/u, token);
    }
  }

  const options = new Map(managementOptions.map((option) => [option.name, option]));
  for (const command of managementCommands) {
    assert.equal(parseManagementArguments([command.name]).command, command.name);
    assert.doesNotThrow(() => renderCliHelp(command.name), command.name);
    for (const name of command.options) {
      const option = options.get(name);
      assert.notEqual(option, undefined, `${command.name}: ${name}`);
      const parsed = parseManagementArguments([
        command.name,
        option!.long,
        ...(option!.value === undefined ? [] : [optionValue(option!.name, option!.values)]),
      ]);
      assert.equal(parsed.flags.has(name), true, `${command.name}: ${option!.long}`);
    }
  }
});

test("generated scripts cover every static command, option, and fixed value without recursive evaluation", () => {
  for (const shell of CLI_COMPLETION_SHELLS) {
    const script = renderShellCompletion(shell);
    assert.equal(script.endsWith("\n"), true, shell);
    assert.doesNotMatch(script, /\r|\0/u, shell);
    assert.doesNotMatch(script, /\beval\b|\brigyn\s+(?:completions|--list-models)\b/u, shell);
    assertBalancedQuotes(script);

    for (const command of managementCommands) {
      assert.match(script, new RegExp(`(?:^|[^a-z0-9-])${command.name}(?:$|[^a-z0-9-])`, "mu"), `${shell}: ${command.name}`);
      for (const value of [...(command.subcommands ?? []), ...(command.argumentValues ?? [])]) {
        assert.equal(script.includes(value), true, `${shell}: ${command.name} ${value}`);
      }
    }
    for (const action of EXTENSION_AUTHOR_COMMANDS) assert.equal(script.includes(action), true, `${shell}: ${action}`);
    for (const option of [...agentOptions, ...managementOptions]) {
      if (shell === "fish") {
        assert.equal(script.includes(`-l ${option.long.slice(2)}`), true, `${shell}: ${option.long}`);
        if (option.short !== undefined) {
          const kind = option.short.length === 2 ? "-s" : "-o";
          assert.equal(script.includes(`${kind} ${option.short.slice(1)}`), true, `${shell}: ${option.short}`);
        }
      } else {
        assert.equal(script.includes(option.long), true, `${shell}: ${option.long}`);
        if (option.short !== undefined) assert.equal(script.includes(option.short), true, `${shell}: ${option.short}`);
      }
      if (option.values !== undefined) {
        for (const value of option.values) assert.equal(script.includes(value), true, `${shell}: ${option.long} ${value}`);
      }
    }
  }
});

test("generated scripts satisfy deterministic syntax contracts", () => {
  const bash = renderShellCompletion("bash");
  const zsh = renderShellCompletion("zsh");
  const fish = renderShellCompletion("fish");

  assert.equal(occurrences(bash, /^\s*case\b/gmu), occurrences(bash, /^\s*esac\b/gmu));
  assert.equal(occurrences(bash, /^\s*if\b/gmu), occurrences(bash, /^\s*fi\b/gmu));
  assert.match(bash, /^_rigyn\(\) \{[\s\S]*^\}$/mu);
  assert.match(bash, /^complete -o bashdefault -o default -F _rigyn rigyn$/mu);

  assert.match(zsh, /^#compdef rigyn$/mu);
  assert.equal(occurrences(zsh, /^\s*case\b/gmu), occurrences(zsh, /^\s*esac\b/gmu));
  assert.equal(occurrences(zsh, /^\s*if\b/gmu), occurrences(zsh, /^\s*fi\b/gmu));
  assert.match(zsh, /^compdef _rigyn rigyn$/mu);

  for (const line of fish.split("\n").filter((line) => line !== "" && !line.startsWith("#"))) {
    assert.match(line, /^complete -c rigyn(?: |$)/u);
  }

  const snapshot = CLI_COMPLETION_SHELLS.map((shell) => {
    const script = renderShellCompletion(shell);
    return {
      shell,
      bytes: Buffer.byteLength(script),
      lines: script.split("\n").length,
      sha256: createHash("sha256").update(script).digest("hex"),
    };
  });
  assert.deepEqual(snapshot, [
    {
      shell: "bash",
      bytes: 6_888,
      lines: 122,
      sha256: "b0f3f361c36def53c28b961049a607e90389e1376b2d203959c0736967ca606e",
    },
    {
      shell: "zsh",
      bytes: 6_868,
      lines: 122,
      sha256: "94641d4f9058addc189e9751d0c731aea8caed8ebbaf5b5234b8ea3407a65381",
    },
    {
      shell: "fish",
      bytes: 17_606,
      lines: 139,
      sha256: "1defd0717a641630cdc2e4b20ba118cc363c8729ed3f402b593bf290820c69db",
    },
  ]);
});

test("bash accepts its generated script when bash is available", () => {
  const parsed = spawnSync("bash", ["-n"], { input: renderShellCompletion("bash"), encoding: "utf8" });
  if (parsed.error !== undefined && (parsed.error as NodeJS.ErrnoException).code === "ENOENT") return;
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("the CLI writes only the requested script and rejects missing, extra, or unsupported shells", () => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-completions-"));
  const agentDirectory = join(root, "state-must-not-be-created");
  try {
    for (const shell of CLI_COMPLETION_SHELLS) {
      const result = cli(["completions", shell], { RIGYN_HOME: agentDirectory });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, renderShellCompletion(shell));
      assert.equal(result.stderr, "");
      assert.equal(existsSync(agentDirectory), false);
    }

    const help = cli(["completions", "--help"], { RIGYN_HOME: agentDirectory });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /source <\(rigyn completions bash\)/u);
    assert.match(help.stdout, /rigyn completions fish \| source/u);
    assert.equal(help.stderr, "");
    assert.equal(existsSync(agentDirectory), false);

    for (const args of [
      ["completions"],
      ["completions", "bash", "extra"],
      ["completions", "powershell"],
    ]) {
      const result = cli(args, { RIGYN_HOME: agentDirectory });
      assert.equal(result.status, 1, `${args.join(" ")}\n${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /bash, zsh, (?:or )?fish/u);
      assert.equal(existsSync(agentDirectory), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
