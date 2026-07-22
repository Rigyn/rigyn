import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RIGYN_PRODUCT_PACKAGE_GRAPH,
  managedCommand,
  posixLauncher,
  windowsLauncher,
} from "../../scripts/lifecycle-common.mjs";
import { runBoundedCommand } from "../../../../scripts/bounded-command.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const PACKED_ARTIFACT_TEST_TIMEOUT_MS = 20 * 60_000;
const PACKED_INSTALL_BOOTSTRAP_TIMEOUT_MS = process.platform === "win32" ? 180_000 : 120_000;
const SELF_UPDATE_TIMEOUT_MS = process.platform === "win32" ? 180_000 : 90_000;
const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:api_?key|auth(?:orization)?|cookie|credential|id_?token|password|passwd|private_?key|refresh_?token|secret|token)(?:_|$)/iu;
const ALLOWED_DOCUMENTS = new Set([
  "docs/ARCHITECTURE.md",
  "docs/README.md",
  "docs/cli-reference.md",
  "docs/compaction.md",
  "docs/configuration.md",
  "docs/cookbook.md",
  "docs/diagnostics.md",
  "docs/embedding.md",
  "docs/execution-backends.md",
  "docs/extension-auth-threat-model.md",
  "docs/extension-capabilities.json",
  "docs/extension-capabilities.md",
  "docs/extension-events.md",
  "docs/extensions.md",
  "docs/generic-api-compatibility.md",
  "docs/getting-started.md",
  "docs/image-generation.md",
  "docs/install.md",
  "docs/keybindings.md",
  "docs/live-provider-testing.md",
  "docs/modes.md",
  "docs/packages.md",
  "docs/package-gallery.md",
  "docs/platforms.md",
  "docs/prompt-templates.md",
  "docs/providers.md",
  "docs/provider-model-catalog.md",
  "docs/public-api.md",
  "docs/releasing.md",
  "docs/resource-catalog.md",
  "docs/rpc.md",
  "docs/sdk.md",
  "docs/session-export.md",
  "docs/session-jsonl.md",
  "docs/sessions.md",
  "docs/skills.md",
  "docs/terminal-setup.md",
  "docs/themes.md",
  "docs/troubleshooting.md",
  "docs/tui.md",
]);
const PUBLIC_LAYER_DIRECTORIES = [
  "auth",
  "config",
  "context",
  "core",
  "embedding",
  "extensions",
  "images",
  "interfaces",
  "modes",
  "net",
  "process",
  "prompts",
  "providers",
  "sdk",
  "service",
  "storage",
  "testing",
  "tools",
  "tui",
];
const DIRECT_DEPENDENCY_LICENSE_FILES = [
  ["@anthropic-ai/sdk", "LICENSE"],
  ["@vscode/ripgrep", "LICENSE"],
  ["bmp-js", "LICENSE"],
  ["ignore", "LICENSE-MIT"],
  ["minimatch", "LICENSE.md"],
  ["openai", "LICENSE"],
  ["semver", "LICENSE"],
  ["sharp", "LICENSE"],
  ["tsx", "LICENSE"],
  ["undici", "LICENSE"],
  ["yaml", "LICENSE"],
];

function errno(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function environmentValue(environment, name) {
  const target = name.toLowerCase();
  return Object.entries(environment).find(([candidate, value]) =>
    candidate.toLowerCase() === target && value !== undefined && value !== "")?.[1];
}

function prependEnvironmentPath(environment, entry, separator = delimiter) {
  const inherited = environmentValue(environment, "PATH");
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => name.toLowerCase() !== "path")),
    PATH: inherited === undefined ? entry : `${entry}${separator}${inherited}`,
  };
}

function commandInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) {
    return { command, args };
  }
  const comspec = environmentValue(options.environment ?? {}, "ComSpec") ?? "cmd.exe";
  return {
    command: comspec,
    args: ["/d", "/s", "/v:off", "/c", command, ...args],
  };
}

function stopProcessTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    if (killed.status === 0) return;
  }
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (errno(error) === "ESRCH") return;
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath !== undefined && npmExecPath !== "") {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

async function runCommand(command, args, options) {
  const invocation = commandInvocation(command, args, { environment: options.env });
  return await runBoundedCommand(invocation.command, invocation.args, {
    ...options,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
}

async function runNpm(args, options) {
  const invocation = npmInvocation(args);
  return await runCommand(invocation.command, invocation.args, options);
}

async function waitForCondition(condition, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function writeLegacyInstallation(installRoot, home, commandLink) {
  const launcher = process.platform === "win32"
    ? join(installRoot, "bin", "rigyn.cmd")
    : join(installRoot, "bin", "rigyn");
  const launcherContents = process.platform === "win32" ? windowsLauncher() : posixLauncher(installRoot);
  const expectedCommand = process.platform === "win32"
    ? launcher
    : join(home, ".local", "bin", "rigyn");
  await mkdir(join(installRoot, "bin"), { recursive: true, mode: 0o700 });
  await writeFile(launcher, launcherContents, { mode: 0o755 });
  if (commandLink === expectedCommand && commandLink !== launcher) {
    await mkdir(join(home, ".local", "bin"), { recursive: true, mode: 0o700 });
    await writeFile(commandLink, managedCommand(launcher), { mode: 0o755 });
  }
  await writeFile(join(installRoot, ".installation.json"), JSON.stringify({
    product: "rigyn",
    schemaVersion: 1,
    version: "0.0.0",
    commandLink,
  }));
  return { launcher, expectedCommand };
}

function isolatedEnvironment(paths) {
  const environment = {};
  const inherited = new Set([
    "comspec",
    "include",
    "lang",
    "lc_all",
    "lib",
    "libpath",
    "path",
    "pathext",
    "systemroot",
    "tz",
    "windir",
  ]);
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && inherited.has(name.toLowerCase())) environment[name] = value;
  }
  Object.assign(environment, {
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_STATE_HOME: paths.state,
    TMPDIR: paths.temporary,
    TMP: paths.temporary,
    TEMP: paths.temporary,
    NO_COLOR: "1",
    TERM: "dumb",
    npm_config_audit: "false",
    npm_config_cache: paths.npmCache,
    npm_config_fund: "false",
    npm_config_globalconfig: paths.npmGlobalConfig,
    npm_config_ignore_scripts: "true",
    npm_config_loglevel: "error",
    npm_config_logs_dir: paths.npmLogs,
    npm_config_progress: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: paths.npmUserConfig,
  });
  return environment;
}

function offlineNpmCache() {
  const configured = process.env.npm_config_cache;
  if (configured !== undefined && configured !== "") return configured;
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "npm-cache")
    : join(homedir(), ".npm");
}

function packagePathAllowed(path) {
  return path === "CHANGELOG.md"
    || path === "LICENSE"
    || path === "README.md"
    || path === "SECURITY.md"
    || path === "package.json"
    || path === "scripts/lifecycle-common.mjs"
    || path === "scripts/install-user.mjs"
    || path === "scripts/update-user.mjs"
    || path === "scripts/uninstall-user.mjs"
    || path.startsWith("dist/")
    || path.startsWith("examples/")
    || path.startsWith("resources/")
    || ALLOWED_DOCUMENTS.has(path);
}

function assertSafePackageFiles(files) {
  const paths = files.map((entry) => String(entry.path).replaceAll("\\", "/"));
  const unexpected = paths.filter((path) => !packagePathAllowed(path));
  assert.deepEqual(unexpected, [], `packed artifact contains unexpected files: ${unexpected.join(", ")}`);
  for (const path of paths) {
    assert.doesNotMatch(path, /(?:^|\/)(?:src|test|\.audit)(?:\/|$)/u);
    assert.doesNotMatch(path, /(?:^|\/)\.env(?:\.|\/|$)/iu);
    assert.doesNotMatch(
      path,
      /^dist\/(?:checkpoints|daemon|hooks|image-generation|lsp|mcp|memory|policy|sandbox|subagents|worktrees)(?:\/|$)/u,
    );
    assert.doesNotMatch(
      path,
      /^dist\/(?:cli\/daemon-command|tools\/(?:workspace-lock|builtins\/web-fetch))\./u,
    );
  }
  for (const required of [
    "package.json",
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "docs/getting-started.md",
    "docs/cli-reference.md",
    "docs/generic-api-compatibility.md",
    "docs/install.md",
    "docs/keybindings.md",
    "docs/prompt-templates.md",
    "docs/public-api.md",
    "docs/README.md",
    "docs/releasing.md",
    "docs/session-jsonl.md",
    "docs/skills.md",
    "docs/terminal-setup.md",
    "docs/themes.md",
    "dist/bin/rigyn.js",
    "dist/bin/tool-backend-worker.js",
    "dist/rpc-entry.js",
    "dist/index.js",
    "scripts/lifecycle-common.mjs",
    "scripts/install-user.mjs",
    "scripts/update-user.mjs",
    "scripts/uninstall-user.mjs",
    "examples/embedding-runtime.mjs",
    "examples/embedding-in-memory.mjs",
    "examples/embedding-cancellation.mjs",
    "examples/starter/package.json",
    "examples/starter/extensions/index.mjs",
    "examples/provider-override/package.json",
    "examples/provider-override/extensions/index.mjs",
    "examples/raw-editor-ui/package.json",
    "examples/raw-editor-ui/extensions/index.mjs",
    "examples/session-jsonl/package.json",
    "examples/session-jsonl/extensions/index.mjs",
    "examples/session-control/package.json",
    "examples/session-control/extensions/index.mjs",
    "examples/subprocess-workers/package.json",
    "examples/subprocess-workers/extensions/index.mjs",
    "examples/dynamic-package/package.json",
    "examples/dynamic-package/extensions/index.mjs",
    "resources/package-gallery.json",
    "resources/settings.example.json",
    "resources/schemas/package-gallery-v1.json",
    "resources/prompts/build-extension.md",
    "resources/skills/build-extension/SKILL.md",
    "resources/skills/build-extension/references/dashboard.md",
    ...PUBLIC_LAYER_DIRECTORIES.flatMap((directory) => [
      `dist/${directory}/index.js`,
      `dist/${directory}/index.d.ts`,
    ]),
  ]) assert.ok(paths.includes(required), `packed artifact is missing ${required}`);
}

test("Windows command shims use the isolated command processor without a shell", () => {
  const command = String.raw`C:\Rigyn Home\bin\rigyn.cmd`;
  const comspec = String.raw`C:\Windows\System32\cmd.exe`;
  assert.deepEqual(
    commandInvocation(command, ["--version"], { platform: "win32", environment: { COMSPEC: comspec } }),
    {
      command: comspec,
      args: ["/d", "/s", "/v:off", "/c", command, "--version"],
    },
  );
});

test("installer PATH normalization preserves a mixed-case Windows Path once", () => {
  const environment = prependEnvironmentPath(
    { Path: String.raw`C:\hostedtoolcache\node`, HOME: String.raw`C:\home` },
    String.raw`C:\home\.local\bin`,
    ";",
  );
  assert.equal(environment.PATH, String.raw`C:\home\.local\bin;C:\hostedtoolcache\node`);
  assert.deepEqual(Object.keys(environment).filter((name) => name.toLowerCase() === "path"), ["PATH"]);
});

test("packed artifact bootstraps into a blank home and completes a cached offline user install", {
  // Every subprocess has a tighter phase-specific timeout. This ceiling only bounds
  // their cumulative runtime across packing, install, update, rollback, and uninstall.
  timeout: PACKED_ARTIFACT_TEST_TIMEOUT_MS,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-packed-artifact-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const paths = {
    root,
    home: join(root, "home"),
    appData: join(root, "home", "AppData", "Roaming"),
    localAppData: join(root, "home", "AppData", "Local"),
    cache: join(root, "cache"),
    config: join(root, "config"),
    state: join(root, "state"),
    temporary: join(root, "tmp"),
    npmCache: offlineNpmCache(),
    npmLogs: join(root, "npm-logs"),
    npmUserConfig: join(root, "npmrc"),
    npmGlobalConfig: join(root, "npmrc-global"),
    pack: join(root, "pack"),
    installDriver: join(root, "install-driver"),
    fakeGlobal: join(root, "fake-global"),
    installRoot: join(root, "custom-install"),
    workspace: join(root, "workspace"),
  };
  await Promise.all([
    paths.home,
    paths.appData,
    paths.localAppData,
    paths.cache,
    paths.config,
    paths.state,
    paths.temporary,
    paths.npmLogs,
    paths.pack,
    paths.installDriver,
    paths.fakeGlobal,
    paths.workspace,
  ].map(async (path) => await mkdir(path, { recursive: true, mode: 0o700 })));
  await Promise.all([
    writeFile(paths.npmUserConfig, "", { mode: 0o600 }),
    writeFile(paths.npmGlobalConfig, "", { mode: 0o600 }),
  ]);
  paths.environment = isolatedEnvironment(paths);
  Object.assign(paths.environment, {
    RIGYN_INSTALL_NPM_CACHE: paths.npmCache,
    npm_config_prefix: paths.fakeGlobal,
  });
  const bootstrapEnvironment = {
    ...prependEnvironmentPath(paths.environment, join(paths.home, ".local", "bin")),
    RIGYN_INSTALL_DIR: paths.installRoot,
    npm_config_bin_links: "false",
    npm_config_global: "true",
    npm_config_prefer_offline: "true",
    npm_config_omit: "dev optional",
  };
  const installerEnvironment = {
    ...bootstrapEnvironment,
    npm_config_offline: "true",
  };
  assert.equal(
    installerEnvironment.npm_execpath,
    undefined,
    "the self-contained installer must work without npm lifecycle metadata",
  );
  const globalSentinel = join(paths.fakeGlobal, "global-sentinel.txt");
  await writeFile(globalSentinel, "must remain untouched\n");
  const immutableSourcePaths = [
    join(PROJECT_ROOT, "package.json"),
    join(REPOSITORY_ROOT, "package-lock.json"),
    join(PROJECT_ROOT, "dist", "bin", "rigyn.js"),
  ];
  const immutableSource = new Map(await Promise.all(immutableSourcePaths.map(async (path) => {
    const metadata = await lstat(path);
    return [path, { content: await readFile(path), mtimeMs: metadata.mtimeMs }];
  })));
  await access(paths.npmCache, constants.R_OK);
  assert.deepEqual(
    Object.keys(paths.environment).filter((name) => SENSITIVE_ENVIRONMENT_NAME.test(name)),
    [],
    "packed-artifact subprocesses must not inherit credential variables",
  );

  const tarballs = [];
  let packed;
  for (const { name, directory } of RIGYN_PRODUCT_PACKAGE_GRAPH) {
    const packageRoot = join(REPOSITORY_ROOT, directory);
    const packedOutput = await runNpm([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      paths.pack,
      packageRoot,
    ], {
      cwd: packageRoot,
      env: paths.environment,
      timeoutMs: 60_000,
      label: `npm pack ${name}`,
    });
    const result = JSON.parse(packedOutput.stdout);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, name);
    if (name === "rigyn") {
      packed = result;
      assertSafePackageFiles(result[0]?.files ?? []);
    }
    tarballs.push(join(paths.pack, result[0].filename));
  }
  const tarball = tarballs.at(-1);
  await access(tarball, constants.R_OK);

  const productManifest = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8"));
  await writeFile(join(paths.installDriver, "package.json"), `${JSON.stringify({
    name: "rigyn-packed-installer-driver",
    private: true,
    version: "0.0.0",
    overrides: { "@types/node": productManifest.devDependencies["@types/node"] },
  }, null, 2)}\n`);

  await runNpm([
    "install",
    "--global=false",
    "--omit=dev",
    "--include=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    paths.installDriver,
    ...tarballs,
  ], {
    cwd: paths.installDriver,
    env: bootstrapEnvironment,
    timeoutMs: PACKED_INSTALL_BOOTSTRAP_TIMEOUT_MS,
    label: "packed installer bootstrap",
  });
  const installerPackageRoot = join(paths.installDriver, "node_modules", "rigyn");
  const installer = await runCommand(process.execPath, [join(installerPackageRoot, "scripts", "install-user.mjs")], {
    cwd: installerPackageRoot,
    env: installerEnvironment,
    timeoutMs: 120_000,
    label: "self-contained user install",
  });
  assert.match(installer.stdout, /Installed a self-contained Rigyn copy/u);
  if (process.platform !== "win32") assert.match(installer.stdout, /Run rigyn from any directory\./u);
  assert.equal(await readFile(globalSentinel, "utf8"), "must remain untouched\n");
  const packageRoot = join(paths.installRoot, "app", "node_modules", "rigyn");
  assert.equal((await lstat(packageRoot)).isSymbolicLink(), false, "installed package root must be an independent copy");
  assert.notEqual(await realpath(packageRoot), await realpath(PROJECT_ROOT), "installed package must not resolve to the source checkout");
  const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageManifest.version, packed[0].version);
  assert.doesNotMatch(
    String(packageManifest.scripts?.build ?? ""),
    /\bnpm(?:\.cmd)?\s+run(?:\s|$)/iu,
    "source builds must not resolve a nested npm executable from PATH",
  );
  await Promise.all([
    access(join(packageRoot, "CHANGELOG.md"), constants.R_OK),
    access(join(packageRoot, "LICENSE"), constants.R_OK),
    access(join(packageRoot, "README.md"), constants.R_OK),
    access(join(packageRoot, "SECURITY.md"), constants.R_OK),
  ]);
  for (const [dependency, license] of DIRECT_DEPENDENCY_LICENSE_FILES) {
    await access(join(paths.installRoot, "app", "node_modules", ...dependency.split("/"), license), constants.R_OK);
  }
  await Promise.all([
    access(join(packageRoot, "resources", "settings.example.json")),
    access(join(packageRoot, "resources", "prompts", "build-extension.md")),
    access(join(packageRoot, "resources", "skills", "build-extension", "SKILL.md")),
    access(join(packageRoot, "resources", "skills", "build-extension", "references", "dashboard.md")),
  ]);
  const appManifest = JSON.parse(await readFile(join(paths.installRoot, "app", "package.json"), "utf8"));
  assert.equal(appManifest.dependencies?.["rigyn"], packed[0].version);
  const globalSettingsPath = join(paths.installRoot, "agent", "settings.json");
  await assert.rejects(access(globalSettingsPath), (error) => errno(error) === "ENOENT");
  await assert.rejects(access(join(paths.installRoot, "app", "package-lock.json")), (error) => errno(error) === "ENOENT");
  const ripgrepModule = pathToFileURL(join(packageRoot, "dist", "tools", "ripgrep.js")).href;
  const ripgrepCheck = await runCommand(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      `const { resolveRipgrep } = await import(${JSON.stringify(ripgrepModule)})`,
      "const rgPath = await resolveRipgrep({ environment: { PATH: '' } })",
      "if (rgPath === undefined) throw new Error('installed bundled ripgrep is unavailable')",
      "const { spawnSync } = await import('node:child_process')",
      "const result = spawnSync(rgPath, ['--version'], { encoding: 'utf8', env: { PATH: '' } })",
      "if (result.status !== 0) throw new Error(result.stderr || 'installed bundled ripgrep failed')",
      "process.stdout.write(result.stdout)",
    ].join(";"),
  ], {
    cwd: packageRoot,
    env: { ...paths.environment, PATH: "" },
    timeoutMs: 30_000,
    label: "installed bundled ripgrep",
  });
  assert.match(ripgrepCheck.stdout, /^ripgrep \d+/u);
  assert.equal(ripgrepCheck.stderr, "");
  const commandShim = process.platform === "win32"
    ? join(paths.installRoot, "bin", "rigyn.cmd")
    : join(paths.installRoot, "bin", "rigyn");
  await access(commandShim, constants.R_OK);
  if (process.platform !== "win32") {
    await access(commandShim, constants.X_OK);
    const shimVersion = await runCommand(commandShim, ["--version"], {
      cwd: paths.workspace,
      env: paths.environment,
      timeoutMs: 30_000,
      label: "installed command shim",
    });
    assert.equal(shimVersion.stdout, `${packed[0].version}\n`);
    assert.equal(shimVersion.stderr, "");
  }

  const version = await runCommand(commandShim, ["--version"], {
    cwd: paths.workspace,
    env: paths.environment,
    timeoutMs: 30_000,
    label: "installed launcher --version",
  });
  assert.equal(version.stdout, `${packed[0].version}\n`);
  assert.equal(version.stderr, "");

  const transformedHelper = join(paths.workspace, "extension-helper.ts");
  const transformedExtension = join(paths.workspace, "transformed-extension.ts");
  await Promise.all([
    writeFile(join(paths.workspace, "package.json"), JSON.stringify({ type: "module" })),
    writeFile(transformedHelper, `export enum ExtensionReply { Ready = "Packed TypeScript extension loaded" }\n`),
    writeFile(transformedExtension, `
import { ExtensionReply } from "./extension-helper";

const modelId = "packed-typescript-v1";

export default function activate(api: any) {
  api.registerProvider("packed-typescript", {
    name: "Packed TypeScript",
    api: "openai-chat-completions",
    baseUrl: "https://offline.invalid/v1",
    apiKey: "fixture",
    async *streamSimple(model: any, _context: any, options: any) {
      options?.signal?.throwIfAborted();
      yield { type: "response_start", model: model.id };
      yield { type: "text_delta", part: 0, text: ExtensionReply.Ready };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: ExtensionReply.Ready } }
      };
    },
    models: [{
      id: modelId,
      name: "Packed TypeScript",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024
    }]
  });
}
`),
  ]);
  const transformedRun = await runCommand(commandShim, [
    "TypeScript transform check",
    "--extension",
    transformedExtension,
    "--provider",
    "packed-typescript",
    "--model",
    "packed-typescript-v1",
    "--no-session",
    "--print",
    "--workspace",
    paths.workspace,
  ], {
    cwd: paths.workspace,
    env: paths.environment,
    timeoutMs: 30_000,
    label: "installed transformed TypeScript extension",
  });
  assert.equal(transformedRun.stdout, "Packed TypeScript extension loaded\n");
  assert.equal(transformedRun.stderr, "");

  const commandLink = process.platform === "win32"
    ? commandShim
    : join(paths.home, ".local", "bin", "rigyn");
  if (process.platform !== "win32") {
    assert.equal((await lstat(commandLink)).isFile(), true, "user command must be a managed launcher");
    assert.match(await readFile(commandLink, "utf8"), /^#!\/usr\/bin\/env sh\n# rigyn managed command\n/u);
    const bareCommand = await runCommand("rigyn", ["--version"], {
      cwd: paths.workspace,
      env: installerEnvironment,
      timeoutMs: 30_000,
      label: "installed bare command from another directory",
    });
    assert.equal(bareCommand.stdout, `${packed[0].version}\n`);
    assert.equal(bareCommand.stderr, "");
  }
  const installationMarker = JSON.parse(await readFile(join(paths.installRoot, ".installation.json"), "utf8"));
  assert.equal(installationMarker.schemaVersion, 2);
  assert.match(installationMarker.installationId, /^[a-f0-9]{32}$/u);
  assert.equal(installationMarker.installRoot, paths.installRoot);
  assert.equal(installationMarker.launcherPath, commandShim);
  assert.equal(installationMarker.commandLink, commandLink);
  assert.equal(
    installationMarker.launcherSha256,
    createHash("sha256").update(await readFile(commandShim)).digest("hex"),
  );
  assert.equal(
    installationMarker.commandSha256,
    createHash("sha256").update(await readFile(commandLink)).digest("hex"),
  );
  const help = await runCommand(commandShim, ["--help"], {
    cwd: paths.workspace,
    env: paths.environment,
    timeoutMs: 30_000,
    label: "installed launcher --help",
  });
  assert.ok(help.stdout.startsWith(`Rigyn ${packed[0].version} —`));
  assert.match(help.stdout, /Usage:\n/u);
  assert.equal(help.stderr, "");
  assert.deepEqual(await readdir(paths.config), []);
  assert.deepEqual(await readdir(paths.state), []);
  for (const directory of ["app", "bin", "cache", "config", "data", "home", "logs", "npm-prefix", "state", "tmp"]) {
    assert.ok((await lstat(join(paths.installRoot, directory))).isDirectory(), `${directory} must stay inside the installation root`);
  }
  const keepRoot = join(paths.installRoot, "keep.txt");
  const keepBin = join(paths.installRoot, "bin", "keep.txt");
  const customizedSettings = `${JSON.stringify({ theme: "dark", quietStartup: true }, null, 2)}\n`;
  await mkdir(join(paths.installRoot, "agent"), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(keepRoot, "keep root\n"),
    writeFile(keepBin, "keep bin\n"),
    writeFile(globalSettingsPath, customizedSettings, { mode: 0o600 }),
  ]);
  const interruptedApp = join(paths.installRoot, ".app-previous");
  await rename(join(paths.installRoot, "app"), interruptedApp);
  await writeFile(join(paths.installRoot, ".install-transaction.json"), `${JSON.stringify({
    product: "rigyn",
    schemaVersion: 1,
    transactionId: "a".repeat(32),
    pid: process.pid,
    createdAt: Date.now(),
    rootExisted: true,
    rootMode: (await lstat(paths.installRoot)).mode & 0o777,
    previousMarkerSha256: createHash("sha256")
      .update(await readFile(join(paths.installRoot, ".installation.json")))
      .digest("hex"),
  }, null, 2)}\n`);
  await runCommand(process.execPath, [join(PROJECT_ROOT, "scripts", "install-user.mjs")], {
    cwd: PROJECT_ROOT,
    env: bootstrapEnvironment,
    timeoutMs: 120_000,
    label: "repeat self-contained user install after interrupted swap",
  });
  await assert.rejects(access(interruptedApp), (error) => errno(error) === "ENOENT");
  assert.equal(await readFile(keepRoot, "utf8"), "keep root\n");
  assert.equal(await readFile(keepBin, "utf8"), "keep bin\n");
  assert.equal(await readFile(globalSettingsPath, "utf8"), customizedSettings);
  assert.equal(await readFile(globalSentinel, "utf8"), "must remain untouched\n");
  assert.equal((await lstat(packageRoot)).isSymbolicLink(), false);
  await Promise.all([
    access(join(packageRoot, "CHANGELOG.md"), constants.R_OK),
    access(join(packageRoot, "LICENSE"), constants.R_OK),
    access(join(packageRoot, "README.md"), constants.R_OK),
    access(join(packageRoot, "SECURITY.md"), constants.R_OK),
    access(join(packageRoot, "resources", "prompts", "build-extension.md")),
    access(join(packageRoot, "resources", "skills", "build-extension", "SKILL.md")),
  ]);
  if (process.platform !== "win32") {
    assert.equal((await lstat(commandLink)).isFile(), true, "reinstall must preserve the managed command launcher");
    assert.match(await readFile(commandLink, "utf8"), /^#!\/usr\/bin\/env sh\n# rigyn managed command\n/u);
  }
  assert.equal((await readdir(paths.installRoot)).includes("packages"), false, "the user install must not retain package tarballs");
  for (const [path, before] of immutableSource) {
    assert.deepEqual(await readFile(path), before.content, `installer changed master source file ${path}`);
    assert.equal((await lstat(path)).mtimeMs, before.mtimeMs, `installer rewrote master source file ${path}`);
  }

  const selfUpdate = await runCommand(commandShim, ["self-update"], {
    cwd: paths.workspace,
    env: { ...installerEnvironment, RIGYN_UPDATE_SPEC: tarball },
    timeoutMs: SELF_UPDATE_TIMEOUT_MS,
    label: "offline self update from packed artifact",
  });
  assert.match(selfUpdate.stdout, /Updated Rigyn from .* to /u);
  assert.equal(selfUpdate.stderr, "");
  assert.equal(await readFile(globalSettingsPath, "utf8"), customizedSettings);
  for (const residue of [".app-previous", ".app-install", ".build-install", ".install-transaction.json"]) {
    await assert.rejects(access(join(paths.installRoot, residue)), (error) => errno(error) === "ENOENT");
  }
  const updatedVersion = await runCommand(commandShim, ["--version"], {
    cwd: paths.workspace,
    env: paths.environment,
    timeoutMs: 30_000,
    label: "updated launcher --version",
  });
  assert.equal(updatedVersion.stdout, `${packed[0].version}\n`);

  const starterPackage = join(packageRoot, "examples", "starter");
  const installed = await runCommand(commandShim, [
    "install",
    starterPackage,
    "--workspace",
    paths.workspace,
    "--json",
  ], {
    cwd: paths.workspace,
    env: paths.environment,
    timeoutMs: 30_000,
    label: "offline reference package install",
  });
  assert.equal(JSON.parse(installed.stdout).source, starterPackage);
  assert.equal(installed.stderr, "");

  const persistedSettings = JSON.parse(await readFile(globalSettingsPath, "utf8"));
  assert.equal(
    persistedSettings.packages.some((entry) => typeof entry === "string" && entry.replaceAll("\\", "/").endsWith("/starter")),
    true,
    "installed CLI did not persist the starter package source in settings",
  );

  const failedReinstallNpm = join(paths.root, "failed-reinstall-npm.mjs");
  await writeFile(failedReinstallNpm, "process.exit(37);\n");
  const markerPath = join(paths.installRoot, ".installation.json");
  const installedExecutable = join(packageRoot, "dist", "bin", "rigyn.js");
  const beforeFailedReinstall = {
    marker: await readFile(markerPath),
    executable: await readFile(installedExecutable),
    launcher: await readFile(commandShim),
    command: await readFile(commandLink),
  };
  await assert.rejects(
    runCommand(process.execPath, [join(PROJECT_ROOT, "scripts", "install-user.mjs")], {
      cwd: PROJECT_ROOT,
      env: { ...installerEnvironment, npm_execpath: failedReinstallNpm },
      timeoutMs: 30_000,
      label: "injected failed self-contained reinstall",
    }),
    /npm ci failed with exit 37/u,
  );
  assert.deepEqual(await readFile(markerPath), beforeFailedReinstall.marker);
  assert.deepEqual(await readFile(installedExecutable), beforeFailedReinstall.executable);
  assert.deepEqual(await readFile(commandShim), beforeFailedReinstall.launcher);
  assert.deepEqual(await readFile(commandLink), beforeFailedReinstall.command);
  for (const residue of [".app-previous", ".app-install", ".build-install", ".install-transaction.json"]) {
    await assert.rejects(access(join(paths.installRoot, residue)), (error) => errno(error) === "ENOENT");
  }
  const retainedVersion = await runCommand(commandShim, ["--version"], {
    cwd: paths.workspace,
    env: paths.environment,
    timeoutMs: 30_000,
    label: "launcher after failed reinstall",
  });
  assert.equal(retainedVersion.stdout, `${packed[0].version}\n`);
  assert.equal(retainedVersion.stderr, "");

  const blockingExtension = join(paths.workspace, "blocking-provider.mjs");
  const blockingReady = join(paths.workspace, "blocking-provider-ready");
  await writeFile(blockingExtension, `
import { writeFile } from "node:fs/promises";
export default function activate(api) {
  api.registerProvider("blocking-provider", {
    name: "Blocking provider",
    api: "openai-chat-completions",
    baseUrl: "https://offline.invalid/v1",
    apiKey: "fixture",
    async *streamSimple(model, _context, options) {
    yield { type: "response_start", model: model.id };
    await writeFile(${JSON.stringify(blockingReady)}, "ready");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 60_000);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(options.signal.reason);
      }, { once: true });
    });
    yield { type: "text_delta", part: 0, text: "done" };
    yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } } };
    },
    models: [{
      id: "blocking-v1",
      name: "Blocking v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024
    }]
  });
}
`);
  const activeRuntimeInvocation = commandInvocation(commandShim, [
    "keep the runtime active",
    "--extension",
    blockingExtension,
    "--provider",
    "blocking-provider",
    "--model",
    "blocking-v1",
    "--no-session",
    "--print",
    "--workspace",
    paths.workspace,
  ], { environment: paths.environment });
  const activeRuntime = spawn(activeRuntimeInvocation.command, activeRuntimeInvocation.args, {
    cwd: paths.workspace,
    env: paths.environment,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const activeRuntimeError = [];
  activeRuntime.stderr.on("data", (chunk) => activeRuntimeError.push(chunk));
  let activeRuntimeDone = false;
  const activeRuntimeClosed = new Promise((resolveClose) => activeRuntime.once("close", (code) => {
    activeRuntimeDone = true;
    resolveClose(code);
  }));
  const stopActiveRuntime = () => {
    if (activeRuntimeDone) return;
    stopProcessTree(activeRuntime);
  };
  context.after(stopActiveRuntime);
  await waitForCondition(async () => {
    if (activeRuntimeDone) {
      throw new Error(`installed blocking runtime exited before provider readiness:\n${Buffer.concat(activeRuntimeError).toString("utf8")}`);
    }
    try {
      return await readFile(blockingReady, "utf8") === "ready";
    } catch (error) {
      if (errno(error) === "ENOENT") return false;
      throw error;
    }
  }, "the installed blocking provider");
  assert.equal(
    (await readdir(join(paths.installRoot, ".runtime-leases"))).some((entry) => entry.endsWith(".json")),
    true,
    "the active installed runtime must hold a lease",
  );
  await assert.rejects(
    runCommand(commandShim, ["uninstall", "--yes"], {
      cwd: paths.workspace,
      env: paths.environment,
      timeoutMs: 30_000,
      label: "uninstall while another runtime is active",
    }),
    /Close the other running Rigyn process/u,
  );
  await Promise.all([access(paths.installRoot), access(commandLink)]);
  await assert.rejects(access(`${paths.installRoot}.uninstall.json`), (error) => errno(error) === "ENOENT");
  stopActiveRuntime();
  await waitForCondition(
    () => activeRuntimeDone,
    "the installed blocking provider to stop",
    10_000,
  );
  await activeRuntimeClosed;
  assert.equal(Buffer.concat(activeRuntimeError).toString("utf8").includes("unhandled"), false);

  const uninstalled = await runCommand(commandShim, ["uninstall", "--yes"], {
    cwd: paths.workspace,
    env: paths.environment,
    timeoutMs: 30_000,
    label: "marker-verified product uninstall",
  });
  assert.match(uninstalled.stdout, /Removed the self-contained Rigyn installation/u);
  await assert.rejects(access(paths.installRoot), (error) => errno(error) === "ENOENT");
  await assert.rejects(access(commandLink), (error) => errno(error) === "ENOENT");
  await assert.rejects(access(`${paths.installRoot}.uninstalling`), (error) => errno(error) === "ENOENT");
  await assert.rejects(access(`${paths.installRoot}.uninstall.json`), (error) => errno(error) === "ENOENT");
  assert.equal(await readFile(globalSentinel, "utf8"), "must remain untouched\n");
});

test("self-contained installer refuses an unrecognized home directory without changing it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-install-conflict-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const installRoot = join(root, ".rigyn");
  const sentinel = join(installRoot, "keep.txt");
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  await writeFile(sentinel, "do not replace\n");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["comspec", "lang", "lc_all", "path", "pathext", "systemroot", "tz", "windir"].includes(name.toLowerCase())));
  Object.assign(environment, {
    RIGYN_INSTALL_DIR: installRoot,
    HOME: root,
    USERPROFILE: root,
    NO_COLOR: "1",
  });
  await assert.rejects(
    runCommand(process.execPath, [join(PROJECT_ROOT, "scripts", "install-user.mjs")], {
      cwd: PROJECT_ROOT,
      env: environment,
      timeoutMs: 30_000,
      label: "conflicting self-contained install",
    }),
    /Refusing to replace an unrecognized non-empty directory/u,
  );
  assert.equal(await readFile(sentinel, "utf8"), "do not replace\n");
  assert.deepEqual(await readdir(installRoot), ["keep.txt"]);
});

test("self-contained installer strips credential variables before invoking npm", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-install-environment-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const installRoot = join(root, "install");
  const capture = join(root, "npm-environment.json");
  const fakeNpm = join(root, "fake-npm.mjs");
  await writeFile(fakeNpm, `
import { writeFile } from "node:fs/promises";
await writeFile(process.env.RIGYN_TEST_CAPTURE, JSON.stringify(Object.keys(process.env).sort()));
process.exit(29);
`);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["comspec", "lang", "lc_all", "path", "pathext", "systemroot", "tz", "windir"].includes(name.toLowerCase())));
  Object.assign(environment, {
    RIGYN_INSTALL_DIR: installRoot,
    RIGYN_TEST_CAPTURE: capture,
    RIGYN_TEST_SECRET: "must-not-reach-npm",
    RIGYN_CREDENTIAL_KEY: "must-not-reach-npm",
    NPM_TOKEN: "must-not-reach-npm",
    OPENAI_API_KEY: "must-not-reach-npm",
    HOME: root,
    USERPROFILE: root,
    npm_execpath: fakeNpm,
  });
  await assert.rejects(
    runCommand(process.execPath, [join(PROJECT_ROOT, "scripts", "install-user.mjs")], {
      cwd: PROJECT_ROOT,
      env: environment,
      timeoutMs: 30_000,
      label: "credential-isolated self-contained install",
    }),
    /npm ci failed with exit 29/u,
  );
  const inheritedNames = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(inheritedNames.some((name) => SENSITIVE_ENVIRONMENT_NAME.test(name)), false);
  assert.equal(inheritedNames.includes("RIGYN_TEST_CAPTURE"), true);
});

test("self-contained installer rejects a symlink-parent path into the source checkout", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-install-parent-link-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const linkedProject = join(root, "linked-project");
  const nestedName = `.release-install-escape-${process.pid}`;
  const escapedTarget = join(PROJECT_ROOT, nestedName);
  await assert.rejects(access(escapedTarget), (error) => errno(error) === "ENOENT");
  await symlink(PROJECT_ROOT, linkedProject, "dir");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["comspec", "lang", "lc_all", "path", "pathext", "systemroot", "tz", "windir"].includes(name.toLowerCase())));
  Object.assign(environment, {
    RIGYN_INSTALL_DIR: join(linkedProject, nestedName),
    HOME: root,
    USERPROFILE: root,
  });
  await assert.rejects(
    runCommand(process.execPath, [join(PROJECT_ROOT, "scripts", "install-user.mjs")], {
      cwd: PROJECT_ROOT,
      env: environment,
      timeoutMs: 30_000,
      label: "symlink-parent self-contained install",
    }),
    /Install directory must not overlap the source checkout/u,
  );
  await assert.rejects(access(escapedTarget), (error) => errno(error) === "ENOENT");
});

test("self-update rejects a non-local option-like package spec before npm", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-update-arguments-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const installRoot = join(root, "install");
  const capture = join(root, "npm-update.json");
  const fakeNpm = join(root, "fake-npm.mjs");
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  const expectedCommand = process.platform === "win32"
    ? join(installRoot, "bin", "rigyn.cmd")
    : join(root, ".local", "bin", "rigyn");
  await writeLegacyInstallation(installRoot, root, expectedCommand);
  await writeFile(fakeNpm, `
import { writeFile } from "node:fs/promises";
await writeFile(process.env.RIGYN_TEST_CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  environmentNames: Object.keys(process.env).sort(),
}));
process.exit(31);
`);
  const updateSpec = "--registry=https://untrusted.invalid";
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["comspec", "lang", "lc_all", "path", "pathext", "systemroot", "tz", "windir"].includes(name.toLowerCase())));
  Object.assign(environment, {
    RIGYN_INSTALL_DIR: installRoot,
    RIGYN_TEST_CAPTURE: capture,
    RIGYN_UPDATE_SPEC: updateSpec,
    RIGYN_TEST_SECRET: "must-not-reach-npm",
    OPENAI_API_KEY: "must-not-reach-npm",
    HOME: root,
    USERPROFILE: root,
    npm_execpath: fakeNpm,
  });
  await assert.rejects(
    runCommand(process.execPath, [join(PROJECT_ROOT, "scripts", "update-user.mjs")], {
      cwd: PROJECT_ROOT,
      env: environment,
      timeoutMs: 30_000,
      label: "argument-isolated self update",
    }),
    /RIGYN_UPDATE_SPEC must name an existing local Rigyn product archive/u,
  );
  await assert.rejects(access(capture), (error) => errno(error) === "ENOENT");
});

test("self-uninstall succeeds when the installation is already absent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-uninstall-absent-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const installRoot = join(root, "not-installed");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["comspec", "lang", "lc_all", "path", "pathext", "systemroot", "tz", "windir"].includes(name.toLowerCase())));
  Object.assign(environment, {
    RIGYN_INSTALL_DIR: installRoot,
    HOME: root,
    USERPROFILE: root,
  });

  const result = await runCommand(
    process.execPath,
    [join(PROJECT_ROOT, "scripts", "uninstall-user.mjs"), "--yes"],
    {
      cwd: PROJECT_ROOT,
      env: environment,
      timeoutMs: 30_000,
      label: "already-absent self uninstall",
    },
  );

  assert.equal(result.stdout, `Rigyn is not installed at ${installRoot}\n`);
  assert.equal(result.stderr, "");
  await assert.rejects(access(installRoot), (error) => errno(error) === "ENOENT");
});

test("self-uninstall refuses unsafe or foreign command paths from an otherwise valid marker", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-uninstall-marker-"));
  context.after(async () => await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const installRoot = join(root, "install");
  const outside = join(root, "outside-command");
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  await writeFile(outside, "must remain\n");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["comspec", "lang", "lc_all", "path", "pathext", "systemroot", "tz", "windir"].includes(name.toLowerCase())));
  Object.assign(environment, {
    RIGYN_INSTALL_DIR: installRoot,
    HOME: root,
    USERPROFILE: root,
  });
  await writeLegacyInstallation(installRoot, root, outside);
  await assert.rejects(
    runCommand(process.execPath, [join(PROJECT_ROOT, "scripts", "uninstall-user.mjs"), "--yes"], {
      cwd: PROJECT_ROOT,
      env: environment,
      timeoutMs: 30_000,
      label: "unsafe-marker self uninstall",
    }),
    /Install marker command path does not match this installation/u,
  );
  assert.equal(await readFile(outside, "utf8"), "must remain\n");
  await access(installRoot);

  const foreignCommand = process.platform === "win32"
    ? join(installRoot, "bin", "rigyn.cmd")
    : join(root, ".local", "bin", "rigyn");
  await mkdir(dirname(foreignCommand), { recursive: true, mode: 0o700 });
  await writeFile(foreignCommand, "#!/usr/bin/env sh\necho foreign\n", { mode: 0o755 });
  await writeLegacyInstallation(installRoot, root, foreignCommand);
  await writeFile(foreignCommand, "#!/usr/bin/env sh\necho foreign\n", { mode: 0o755 });
  await assert.rejects(
    runCommand(process.execPath, [join(PROJECT_ROOT, "scripts", "uninstall-user.mjs"), "--yes"], {
      cwd: PROJECT_ROOT,
      env: environment,
      timeoutMs: 30_000,
      label: "foreign-command self uninstall",
    }),
    /(?:Managed command|Install launcher) ownership check failed/u,
  );
  assert.match(await readFile(foreignCommand, "utf8"), /echo foreign/u);
  await access(installRoot);
});
