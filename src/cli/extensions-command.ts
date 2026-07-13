import { flagBoolean, flagString, type ParsedArguments } from "./args.js";
import { loadRuntime } from "./runtime.js";
import {
  LocalExtensionPackageManager,
  ProjectPackageManager,
  discoverExtensions,
  extensionPackageUpdatePolicy,
  listExtensionResources,
  type ExtensionPackageScope,
  type ExtensionPackageProvenance,
  type ExtensionPackageTransactionOptions,
  type ExtensionResourceFilters,
} from "../extensions/index.js";
import { TrustStore, parseHarnessConfig, readJsoncConfig, resolveConfig } from "../config/index.js";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { harnessPaths } from "./paths.js";
import { persistUiTheme } from "./setup.js";
import { updateGlobalConfig } from "./setup.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { TuiController, type TuiSettingItem } from "../tui/index.js";
import {
  inspectExtensionPackage,
  loadExtensionGalleryIndex,
  packExtensionPackage,
  reloadExtensionPackage,
  reportExtensionPackage,
  smokeExtensionPackage,
  validateExtensionPackage,
} from "./extension-author.js";

function output(value: unknown, json: boolean): void {
  writeMachineOutput(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
}

function line(value: string): void {
  writeMachineOutput(`${value}\n`);
}

function packageScope(argumentsValue: ParsedArguments): ExtensionPackageScope {
  const value = flagString(argumentsValue, "scope") ?? (flagBoolean(argumentsValue, "local") ? "project" : "user");
  if (value !== "user" && value !== "project") throw new Error("--scope must be user or project");
  return value;
}

export async function updateAllExtensionPackages(
  manager: {
    list(scope: ExtensionPackageScope): Promise<Array<{ id: string; provenance?: ExtensionPackageProvenance }>>;
    update(
      id: string,
      scope: ExtensionPackageScope,
      sourcePath?: string,
      options?: ExtensionPackageTransactionOptions,
    ): Promise<unknown>;
  },
  scope: ExtensionPackageScope,
  options: ExtensionPackageTransactionOptions = {},
): Promise<{
  scope: ExtensionPackageScope;
  updated: unknown[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}> {
  const installed = await manager.list(scope);
  const updated: unknown[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const entry of installed) {
    if (entry.provenance !== undefined) {
      const policy = extensionPackageUpdatePolicy(entry.provenance);
      if (policy.pinned) {
        skipped.push({ id: entry.id, reason: policy.reason ?? "pinned source" });
        continue;
      }
    }
    try {
      updated.push(await manager.update(entry.id, scope, undefined, options));
    } catch (error) {
      failed.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { scope, updated, skipped, failed };
}

async function packageContext(argumentsValue: ParsedArguments, selectedScope: ExtensionPackageScope) {
  const paths = harnessPaths();
  const workspace = await realpath(resolve(flagString(argumentsValue, "workspace") ?? process.cwd()));
  const approve = flagBoolean(argumentsValue, "approve");
  const deny = flagBoolean(argumentsValue, "no-approve");
  if (approve && deny) throw new Error("--approve and --no-approve are mutually exclusive");
  const trusted = approve || (!deny && await new TrustStore(paths.trustStore).isTrusted(workspace));
  const configured = selectedScope === "project"
    ? resolveConfig({
        globalPath: paths.globalConfig,
        projectPath: join(workspace, ".rigyn", "config.jsonc"),
        projectTrusted: trusted,
      }).value
    : readJsoncConfig(paths.globalConfig) ?? {};
  const config = parseHarnessConfig(configured);
  const manager = new LocalExtensionPackageManager({
    user: paths.userExtensions,
    project: join(workspace, ".rigyn", "extensions"),
  }, {}, {
    ...(config.npmCommand === undefined ? {} : { npm: { command: config.npmCommand[0]!, prefix: config.npmCommand.slice(1) } }),
    ...(config.gitCommand === undefined ? {} : { git: { command: config.gitCommand[0]!, prefix: config.gitCommand.slice(1) } }),
  });
  return { paths, workspace, trusted, manager };
}

function copyFilters(value: ExtensionResourceFilters): Record<string, string[]> {
  return Object.fromEntries(Object.entries(value).map(([id, resources]) => [id, [...resources]]));
}

export async function runPackageConfigCommand(argumentsValue: ParsedArguments): Promise<void> {
  const scope = packageScope(argumentsValue);
  const { paths, workspace, trusted, manager } = await packageContext(argumentsValue, scope);
  if (scope === "project" && !trusted) {
    throw new Error("Project packages contain trusted code. Review the source, then rerun with --approve or save project trust.");
  }
  const projectConfig = join(workspace, ".rigyn", "config.jsonc");
  const selectedConfig = scope === "project"
    ? resolveConfig({ globalPath: paths.globalConfig, projectPath: projectConfig, projectTrusted: true }).value
    : readJsoncConfig(paths.globalConfig) ?? {};
  const filters = copyFilters(parseHarnessConfig(selectedConfig).packageResources);
  const catalog = await discoverExtensions(manager.sources(trusted));
  const resources = listExtensionResources(catalog, filters).filter((resource) =>
    scope === "project" ? resource.scope === "project" : resource.scope === "user");
  if (resources.length === 0) {
    writeMachineOutput(`No ${scope} package resources are installed.\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (flagBoolean(argumentsValue, "json")) output(resources, true);
    else for (const resource of resources) {
      line(`${resource.enabled ? "[x]" : "[ ]"} ${resource.extensionName} · ${resource.kind} · ${resource.label}`);
    }
    return;
  }
  const settings: TuiSettingItem[] = resources.map((resource, index) => ({
    id: `resource-${index}`,
    label: `${resource.extensionName} · ${resource.kind} · ${resource.label}`,
    description: resource.sourcePath,
    value: String(resource.enabled),
    values: ["true", "false"],
  }));
  const terminal = new TuiController();
  terminal.start();
  terminal.setContext({ workspace });
  try {
    await terminal.chooseSettings(settings, async (setting, value) => {
      const index = Number(setting.id.slice("resource-".length));
      const resource = resources[index];
      if (resource === undefined) throw new Error("Package resource selection is stale");
      const disabled = new Set(filters[resource.extensionId] ?? []);
      if (value === "true") disabled.delete(resource.key);
      else disabled.add(resource.key);
      if (disabled.size === 0) delete filters[resource.extensionId];
      else filters[resource.extensionId] = [...disabled].sort((left, right) => left.localeCompare(right));
      await updateGlobalConfig(scope === "project" ? projectConfig : paths.globalConfig, (existing) => ({
        ...existing,
        packageResources: filters,
      }));
    });
  } finally {
    terminal.close();
  }
}

export async function runPackageCommand(argumentsValue: ParsedArguments): Promise<void> {
  const action = argumentsValue.command === "extensions" ? argumentsValue.positionals[0] : argumentsValue.command;
  const offset = argumentsValue.command === "extensions" ? 1 : 0;
  const scope = packageScope(argumentsValue);
  const { paths, trusted, manager } = await packageContext(argumentsValue, scope);
  if (scope === "project" && !trusted && action !== "list") {
    throw new Error("Project packages contain trusted code. Review the source, then run: rigyn config trust --yes");
  }
  const json = flagBoolean(argumentsValue, "json");
  const transactionOptions: ExtensionPackageTransactionOptions = {
    allowScripts: flagBoolean(argumentsValue, "allow-scripts"),
  };
  if (action === "list") {
    const installed = await manager.list(flagString(argumentsValue, "scope") === undefined && !flagBoolean(argumentsValue, "local") ? undefined : scope);
    if (json) output(installed, true);
    else if (installed.length === 0) line("No packages installed.");
    else {
      for (const selectedScope of ["user", "project"] as const) {
        const entries = installed.filter((entry) => entry.scope === selectedScope);
        if (entries.length === 0) continue;
        line(`${selectedScope === "user" ? "User" : "Project"} packages:`);
        for (const entry of entries) {
          line(`  ${entry.id}${entry.version === undefined ? "" : ` @ ${entry.version}`}`);
          line(`    ${entry.packageRoot}`);
        }
      }
    }
    return;
  }
  if (action === "install") {
    const source = argumentsValue.positionals[offset];
    if (source === undefined) throw new Error("install requires a package source: directory, npm:SPEC, git:SOURCE, or HTTPS URL");
    const installed = await manager.install(source, scope, transactionOptions);
    if (json) output(installed, true);
    else line(`Installed ${installed.id}${installed.version === undefined ? "" : ` @ ${installed.version}`} (${scope})`);
    return;
  }
  if (action === "update") {
    const id = argumentsValue.positionals[offset];
    if (flagBoolean(argumentsValue, "all")) {
      if (id !== undefined) throw new Error("update accepts either a package ID or --all, not both");
      const result = await updateAllExtensionPackages(manager, scope, transactionOptions);
      if (json) output(result, true);
      else {
        line(`Updated ${result.updated.length} ${scope} package${result.updated.length === 1 ? "" : "s"}.`);
        for (const skipped of result.skipped) line(`Skipped ${skipped.id}: pinned to ${skipped.reason}`);
        for (const failure of result.failed) line(`Failed ${failure.id}: ${failure.error}`);
      }
      if (result.failed.length > 0) process.exitCode = 1;
      return;
    }
    if (id === undefined) throw new Error("update requires a package ID or --all");
    const updated = await manager.update(id, scope, argumentsValue.positionals[offset + 1], transactionOptions);
    if (json) output(updated, true);
    else line(`Updated ${updated.id}${updated.version === undefined ? "" : ` @ ${updated.version}`} (${scope})`);
    return;
  }
  if (action === "remove" || action === "uninstall") {
    const id = argumentsValue.positionals[offset];
    if (id === undefined) throw new Error("remove requires a package ID");
    const before = await discoverExtensions(manager.sources(trusted));
    const configuredTheme = readJsoncConfig(paths.globalConfig)?.theme;
    const removedTheme = typeof configuredTheme === "string" && before.theme(configuredTheme)?.extensionId === id;
    const removed = await manager.remove(id, scope);
    if (removedTheme) await persistUiTheme(paths, "dark");
    if (json) output({ ...removed, ...(removedTheme ? { themeFallback: "dark" } : {}) }, true);
    else line(`Removed ${id}${removedTheme ? " · theme reset to dark" : ""}`);
    return;
  }
  throw new Error(`Unknown package action: ${action}`);
}

export async function runProjectPackageCommand(argumentsValue: ParsedArguments): Promise<void> {
  if (flagBoolean(argumentsValue, "allow-scripts")) {
    throw new Error("Declarative project packages never persist lifecycle-script permission; use an imperative reviewed install instead");
  }
  const paths = harnessPaths();
  const workspace = await realpath(resolve(flagString(argumentsValue, "workspace") ?? process.cwd()));
  const approve = flagBoolean(argumentsValue, "approve");
  const deny = flagBoolean(argumentsValue, "no-approve");
  if (approve && deny) throw new Error("--approve and --no-approve are mutually exclusive");
  const trusted = approve || (!deny && await new TrustStore(paths.trustStore).isTrusted(workspace));
  const configured = resolveConfig({
    globalPath: paths.globalConfig,
    projectPath: join(workspace, ".rigyn", "config.jsonc"),
    projectTrusted: trusted,
  }).value;
  const config = parseHarnessConfig(configured);
  const manager = new ProjectPackageManager({
    workspace,
    projectTrusted: trusted,
    commands: {
      ...(config.npmCommand === undefined ? {} : { npm: { command: config.npmCommand[0]!, prefix: config.npmCommand.slice(1) } }),
      ...(config.gitCommand === undefined ? {} : { git: { command: config.gitCommand[0]!, prefix: config.gitCommand.slice(1) } }),
    },
  });
  const action = argumentsValue.positionals[0] ?? "check";
  const json = flagBoolean(argumentsValue, "json");
  if (action === "check") {
    const result = await manager.check();
    if (json) output(result, true);
    else {
      line(result.message);
      if (result.packageCount > 0) line(`${result.packageCount} declared project package${result.packageCount === 1 ? "" : "s"}.`);
    }
    if (result.status !== "ready" && result.status !== "absent" && result.status !== "ignored") process.exitCode = 1;
    return;
  }
  if (action === "reconcile") {
    const result = await manager.reconcile();
    if (json) output(result, true);
    else if (result.status === "ignored") line("Project package declarations are ignored until the workspace is trusted.");
    else if (result.status === "absent") line("No project package declaration exists.");
    else line(`${result.changed ? "Reconciled" : "Verified"} ${result.packages.length} locked project package${result.packages.length === 1 ? "" : "s"}.`);
    return;
  }
  if (action === "update") {
    const ids = argumentsValue.positionals.slice(1);
    const all = flagBoolean(argumentsValue, "all");
    const result = await manager.update({ all, ids });
    if (json) output(result, true);
    else line(`Updated the immutable lock and reconciled ${result.packages.length} project package${result.packages.length === 1 ? "" : "s"}.`);
    return;
  }
  throw new Error(`Unknown declarative project package action: ${action}`);
}

export async function runExtensionsCommand(argumentsValue: ParsedArguments): Promise<void> {
  if (["install", "remove", "uninstall", "update", "packages"].includes(argumentsValue.positionals[0] ?? "")) {
    const action = argumentsValue.positionals[0] === "packages" ? "list" : argumentsValue.positionals[0]!;
    await runPackageCommand({ ...argumentsValue, positionals: [action, ...argumentsValue.positionals.slice(1)] });
    return;
  }
  if (argumentsValue.positionals[0] === "author") {
    const action = argumentsValue.positionals[1];
    const source = argumentsValue.positionals[2];
    if (action === undefined) throw new Error("extensions author requires validate, inspect, pack, smoke, reload, report, or index");
    if (source === undefined) throw new Error(`extensions author ${action} requires a local package or index path`);
    let result: unknown;
    if (action === "validate") result = await validateExtensionPackage(source);
    else if (action === "inspect") result = await inspectExtensionPackage(source);
    else if (action === "pack") {
      const destination = argumentsValue.positionals[3];
      if (destination === undefined) throw new Error("extensions author pack requires a destination directory");
      result = await packExtensionPackage(source, destination);
    }
    else if (action === "smoke") result = await smokeExtensionPackage(source);
    else if (action === "reload") result = await reloadExtensionPackage(source);
    else if (action === "report") {
      result = await reportExtensionPackage(source);
      if ((result as { status: string }).status === "error") process.exitCode = 1;
    }
    else if (action === "index") result = await loadExtensionGalleryIndex(source);
    else throw new Error(`Unknown extensions author action: ${action}`);
    output(result, flagBoolean(argumentsValue, "json"));
    return;
  }
  const workspace = flagString(argumentsValue, "workspace");
  const action = argumentsValue.positionals[0] ?? "list";
  const inspectRuntime = action === "doctor" || action === "show" || action === "commands";
  const runtime = await loadRuntime({
    ...(workspace === undefined ? {} : { workspace }),
    extensions: true,
    ...(inspectRuntime ? { extensionRuntime: true } : {}),
  });
  try {
    const json = flagBoolean(argumentsValue, "json");
    if (action === "list") output(runtime.extensions.list(), json);
    else if (action === "doctor") {
      const report = runtime.extensions.doctor();
      const runtimeDiagnostics = runtime.runtimeExtensions.diagnostics();
      output({
        ...report,
        healthy: report.healthy && runtimeDiagnostics.length === 0,
        runtimeDiagnostics,
      }, json);
    }
    else if (action === "commands") output({
      runtime: runtime.runtimeExtensions.commands(),
      templates: runtime.extensions.bundle().commands.map(({ template: _template, ...metadata }) => metadata),
    }, json);
    else if (action === "prompts") output(runtime.extensions.bundle().prompts.map(({ template: _template, ...metadata }) => metadata), json);
    else if (action === "show") {
      const id = argumentsValue.positionals[1];
      if (id === undefined) throw new Error("extensions show requires ID");
      const extension = runtime.extensions.list().find((entry) => entry.id === id);
      if (extension === undefined) throw new Error(`Unknown extension: ${id}`);
      output({
        extension,
        diagnostics: runtime.extensions.doctor().diagnostics.filter((entry) => entry.extensionId === id),
        runtimeDiagnostics: runtime.runtimeExtensions.diagnostics().filter((entry) => entry.extensionId === id),
      }, json);
    } else throw new Error(`Unknown extensions action: ${action}`);
  } finally {
    await runtime.close();
  }
}
