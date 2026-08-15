import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  gitCommandArguments,
  gitCommandEnvironment,
  gitRepositoryIdentity,
  gitRepositoryProtocol,
  resolveGitRemoteRef,
  resolveNativeGitExecutable,
  runGitCommand,
  validateGitRef,
} from "../../src/process/git-runner.js";

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {}
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("Git repository and ref validation rejects every transport and refspec injection surface", () => {
  assert.equal(gitRepositoryProtocol("https://example.com/owner/repository.git"), "https");
  assert.equal(gitRepositoryProtocol("ssh://alice@example.com:2222/owner/repository.git"), "ssh");
  assert.equal(gitRepositoryProtocol("alice@example.com:owner/repository.git"), "ssh");

  for (const repository of [
    "http://example.com/owner/repository.git",
    "git://example.com/owner/repository.git",
    "https://user@example.com/owner/repository.git",
    "https://example.com/owner/repository.git?ref=main",
    "https://example.com/owner/repository.git#main",
    "https://example.com/owner/../repository.git",
    "https://example.com/owner/%2e%2e/repository.git",
    "https://example.com/owner//repository.git",
    "https://example.com/owner/repository.git/",
    "https://example.com/owner/%5crepository.git",
    "https://example.com/owner/%0arepository.git",
    "alice@example.com:owner/../repository.git",
    "alice@example.com:owner\\repository.git",
  ]) assert.throws(() => gitRepositoryProtocol(repository), /credential-free HTTPS or SSH URL/u, repository);

  for (const ref of ["main", "release/1", "refs/heads/main", "a".repeat(40)]) {
    assert.equal(validateGitRef(ref), ref);
  }
  for (const ref of ["-c", "+main", "refs/heads/../secret", "main lock", "main^{commit}", "main@{1}"]) {
    assert.throws(() => validateGitRef(ref), /Invalid Git ref/u, ref);
  }
});

test("Git identities preserve authority distinctions while normalizing default transports", () => {
  assert.equal(
    gitRepositoryIdentity("https://github.com/owner/repository.git"),
    gitRepositoryIdentity("git@github.com:owner/repository"),
  );
  assert.equal(
    gitRepositoryIdentity("ssh://git@github.com/owner/repository.git"),
    gitRepositoryIdentity("git@github.com:owner/repository"),
  );
  assert.notEqual(
    gitRepositoryIdentity("ssh://alice@example.com:22/owner/repository.git"),
    gitRepositoryIdentity("ssh://bob@example.com:2222/owner/repository.git"),
  );
});

test("Git ref resolution is branch-first, handles annotated tags, and never guesses", async () => {
  const revision = "1".repeat(40);
  const tagObject = "2".repeat(40);
  const tagRevision = "3".repeat(40);
  const calls: string[][] = [];
  const run = async (argumentsValue: string[]): Promise<string> => {
    calls.push(argumentsValue);
    return [
      `${tagObject}\trefs/tags/release`,
      `${tagRevision}\trefs/tags/release^{}`,
      `${revision}\trefs/heads/release`,
    ].join("\n");
  };
  assert.deepEqual(await resolveGitRemoteRef(run, "https://example.com/o/r", "release"), {
    fetchRef: "refs/heads/release",
    revision,
  });
  assert.deepEqual(await resolveGitRemoteRef(run, "https://example.com/o/r", "refs/tags/release"), {
    fetchRef: "refs/tags/release",
    revision: tagRevision,
  });
  assert.equal(calls[0]?.includes("refs/heads/release"), true);

  let called = false;
  assert.deepEqual(await resolveGitRemoteRef(async () => {
    called = true;
    return "";
  }, "https://example.com/o/r", "a".repeat(40)), {
    fetchRef: "a".repeat(40),
    revision: "a".repeat(40),
  });
  assert.equal(called, false);
  await assert.rejects(resolveGitRemoteRef(async () => "", "https://example.com/o/r", "missing"), /not advertised/u);
});

test("Git command policy closes config, pager, helper, hook, filter, and SSH proxy inheritance", () => {
  const posix = gitCommandArguments("https", "/private/hooks", "linux");
  const windows = gitCommandArguments("https", "C:\\private\\hooks", "win32");
  assert.equal(posix[0], "--no-pager");
  assert.equal(posix.includes("credential.helper="), true);
  assert.equal(posix.includes("filter.lfs.process="), true);
  assert.equal(posix.includes("core.hooksPath=/private/hooks"), true);
  assert.equal(posix.some((entry) => entry === "cat" || entry.includes("pager=cat")), false);
  assert.equal(windows.includes("core.attributesFile=NUL"), true);
  assert.equal(windows.includes("core.excludesFile=NUL"), true);

  const hostile = {
    PATH: "/bin",
    SSH_AUTH_SOCK: "/agent.sock",
    SSH_AGENT_PID: "123",
    GIT_CONFIG_GLOBAL: "/hostile/config",
    GIT_PAGER: "hostile-pager",
    NPM_TOKEN: "secret",
  };
  const https = gitCommandEnvironment("/private/home", "/private/template", "https", "linux", hostile, "/real/home");
  assert.equal(https.HOME, "/private/home");
  assert.equal(https.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(https.GIT_PAGER, "");
  assert.equal(https.NPM_TOKEN, undefined);
  assert.equal(https.SSH_AUTH_SOCK, undefined);
  const ssh = gitCommandEnvironment("/private/home", "/private/template", "ssh", "linux", hostile, "/real/home");
  assert.equal(ssh.HOME, "/real/home");
  assert.equal(ssh.SSH_AUTH_SOCK, "/agent.sock");
  assert.match(ssh.GIT_SSH_COMMAND ?? "", /ssh -F \/dev\/null -oBatchMode=yes -oPermitLocalCommand=no -oProxyCommand=none/u);
});

test("native Git resolution rejects Windows command shims", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-native-git-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const executable = join(root, "git.exe");
  await writeFile(executable, "fixture");
  await chmod(executable, 0o700);
  assert.equal(resolveNativeGitExecutable(executable, {}, "win32"), executable);
  assert.throws(
    () => resolveNativeGitExecutable(join(root, "git.cmd"), {}, "win32"),
    /native executable/u,
  );
});

test("Git execution is bounded, isolated, cancellable, and kills descendants", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-git-runner-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const template = join(root, "template");
  const script = join(root, "git-fixture.mjs");
  const wrapper = join(root, "git-wrapper");
  const response = join(root, "response");
  const record = join(root, "record.json");
  const pids = join(root, "pids.json");
  await mkdir(home);
  await mkdir(template);
  await writeFile(script, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const [mode, target] = process.argv.slice(2);',
    'if (mode === "record") {',
    '  writeFileSync(target, JSON.stringify({ args: process.argv.slice(4), env: process.env }));',
    '  process.stdout.write("ready");',
    '} else if (mode === "truncate") {',
    '  process.stderr.write("x".repeat(4096));',
    '  process.exit(2);',
    '} else if (mode === "wait") {',
    '  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    '  writeFileSync(target, JSON.stringify([process.pid, child.pid]));',
    '  setInterval(() => {}, 1000);',
    '}',
  ].join("\n"));
  await writeFile(wrapper, [
    "#!/bin/sh",
    'response="$1"',
    "shift",
    'rm -f "$response.stdout" "$response.stderr"',
    '"$@" >"$response.stdout" 2>"$response.stderr"',
    "status=$?",
    '[ -f "$response.stdout" ] && command cat "$response.stdout"',
    '[ -f "$response.stderr" ] && command cat "$response.stderr" >&2',
    "exit $status",
    "",
  ].join("\n"));
  await chmod(wrapper, 0o700);
  const command = (mode: string, target: string): [string, ...string[]] => process.platform === "win32"
    ? [process.execPath, script, mode, target]
    : [wrapper, response, process.execPath, script, mode, target];
  const base = {
    cwd: root,
    protocol: "https" as const,
    home,
    template,
    sourceEnvironment: { PATH: process.env.PATH },
  };
  const output = await runGitCommand({
    ...base,
    argv: command("record", record),
    arguments: ["status"],
    signal: new AbortController().signal,
  });
  assert.equal(output, "ready");
  const recorded = JSON.parse(await readFile(record, "utf8")) as { args: string[]; env: Record<string, string> };
  assert.equal(recorded.args.at(-1), "status");
  assert.equal(recorded.args[0], "--no-pager");
  assert.equal(recorded.env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
  assert.equal(recorded.env.NPM_TOKEN, undefined);

  await assert.rejects(runGitCommand({
    ...base,
    argv: command("truncate", record),
    arguments: ["status"],
    outputLimitBytes: 32,
    signal: new AbortController().signal,
  }), /\[output truncated\]/u);
  await assert.rejects(runGitCommand({
    ...base,
    argv: command("wait", pids),
    arguments: ["status"],
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  }), /timed out/u);
  await waitForFile(pids);
  const timedOutProcesses = JSON.parse(await readFile(pids, "utf8")) as number[];
  for (const pid of timedOutProcesses) {
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, `process ${pid} survived timeout`);
  }
  await rm(pids, { force: true });

  const controller = new AbortController();
  const pending = runGitCommand({
    ...base,
    argv: command("wait", pids),
    arguments: ["status"],
    signal: controller.signal,
  });
  await waitForFile(pids);
  const processes = JSON.parse(await readFile(pids, "utf8")) as number[];
  controller.abort(new Error("cancel fixture"));
  await assert.rejects(pending, /cancel fixture/u);
  for (const pid of processes) {
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, `process ${pid} survived cancellation`);
  }
});
