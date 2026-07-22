import { flagBoolean, flagString, type ManagementArguments as ParsedArguments } from "./management-args.js";
import { activatePackageCandidate, loadRuntime } from "./runtime.js";
import type { RuntimeInlineExtension } from "../extensions/runtime.js";
import { ProjectPackageManager } from "../extensions/project-packages.js";
import { TrustStore } from "../config/index.js";
import type { ProjectTrustResolver } from "./project-trust.js";
import { relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { agentPaths } from "./paths.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { TuiController, type TuiSettingItem } from "../tui/index.js";
import {
  DefaultPackageManager,
  type ResourceType,
} from "../core/package-manager.js";
import { SettingsManager, type PackageSource } from "../core/settings-manager.js";
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

function packageScope(argumentsValue: ParsedArguments): "user" | "project" {
  const value = flagString(argumentsValue, "scope") ?? (flagBoolean(argumentsValue, "local") ? "project" : "user");
  if (value !== "user" && value !== "project") throw new Error("--scope must be user or project");
  return value;
}

export interface PackageCommandOptions {
  projectTrustResolver?: ProjectTrustResolver;
  signal?: AbortSignal;
}

async function packageContext(argumentsValue: ParsedArguments, options: PackageCommandOptions = {}) {
  const paths = agentPaths();
  const workspace = await realpath(resolve(flagString(argumentsValue, "workspace") ?? process.cwd()));
  const approve = flagBoolean(argumentsValue, "approve");
  const deny = flagBoolean(argumentsValue, "no-approve");
  if (approve && deny) throw new Error("--approve and --no-approve are mutually exclusive");
  const trusted = options.projectTrustResolver === undefined
    ? approve || (!deny && await new TrustStore(paths.trustStore).isTrusted(workspace))
    : await options.projectTrustResolver.isTrusted(workspace);
  const settings = SettingsManager.create(workspace, paths.agentDirectory, { projectTrusted: trusted });
  await settings.reload();
  const manager = new DefaultPackageManager({
    cwd: workspace,
    agentDir: paths.agentDirectory,
    settingsManager: settings,
    activateCandidate: activatePackageCandidate,
    ...(flagBoolean(argumentsValue, "offline") ? { offline: true } : {}),
  });
  return { paths, workspace, trusted, settings, manager };
}

export async function runPackageConfigCommand(
  argumentsValue: ParsedArguments,
  options: PackageCommandOptions = {},
): Promise<void> {
  const scope = packageScope(argumentsValue);
  const { workspace, trusted, settings: settingsManager, manager } = await packageContext(argumentsValue, options);
  if (scope === "project" && !trusted) {
    throw new Error("Project packages contain trusted code. Review the source, then rerun with --approve or save project trust.");
  }
  const resolved = await manager.resolve();
  const resources = (["extensions", "skills", "prompts", "themes"] as const).flatMap((kind) =>
    resolved[kind]
      .filter((resource) => resource.metadata.origin === "package" && resource.metadata.scope === scope)
      .map((resource) => {
        const base = resolve(resource.metadata.baseDir ?? workspace);
        const label = relative(base, resource.path).split(sep).join("/") || ".";
        return {
          kind,
          source: resource.metadata.source,
          sourcePath: resource.path,
          label,
          enabled: resource.enabled,
        };
      }));
  if (resources.length === 0) {
    writeMachineOutput(`No ${scope} package resources are installed.\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (flagBoolean(argumentsValue, "json")) output(resources, true);
    else for (const resource of resources) {
      line(`${resource.enabled ? "[x]" : "[ ]"} ${resource.source} · ${resource.kind} · ${resource.label}`);
    }
    return;
  }
  const settings: TuiSettingItem[] = resources.map((resource, index) => ({
    id: `resource-${index}`,
    label: `${resource.source} · ${resource.kind} · ${resource.label}`,
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
      const configured = scope === "project"
        ? settingsManager.getProjectSettings().packages ?? []
        : settingsManager.getGlobalSettings().packages ?? [];
      const sourceOf = (entry: PackageSource): string => typeof entry === "string" ? entry : entry.source;
      const packageIndex = configured.findIndex((entry) => sourceOf(entry) === resource.source);
      if (packageIndex < 0) throw new Error(`Configured package is no longer available: ${resource.source}`);
      const current = configured[packageIndex]!;
      const selected = typeof current === "string" ? { source: current } : { ...current };
      const key = resource.kind as ResourceType;
      const prior = selected[key] ?? [];
      selected[key] = [
        ...prior.filter((pattern) => pattern.replace(/^[!+-]/u, "") !== resource.label),
        `${value === "true" ? "+" : "-"}${resource.label}`,
      ];
      const next = configured.with(packageIndex, selected);
      if (scope === "project") settingsManager.setProjectPackages(next);
      else settingsManager.setPackages(next);
      await settingsManager.flush();
    });
  } finally {
    terminal.close();
  }
}

export async function runPackageCommand(
  argumentsValue: ParsedArguments,
  options: PackageCommandOptions = {},
): Promise<void> {
  const action = argumentsValue.command === "extensions" ? argumentsValue.positionals[0] : argumentsValue.command;
  const offset = argumentsValue.command === "extensions" ? 1 : 0;
  const scope = packageScope(argumentsValue);
  const { trusted, settings, manager } = await packageContext(argumentsValue, options);
  if (scope === "project" && !trusted && action !== "list") {
    throw new Error("Project packages contain trusted code. Review the source, then rerun with --approve or save trust interactively with /trust");
  }
  const json = flagBoolean(argumentsValue, "json");
  const allowScripts = flagBoolean(argumentsValue, "allow-scripts");
  if (action === "list") {
    const scopeSelected = flagString(argumentsValue, "scope") !== undefined || flagBoolean(argumentsValue, "local");
    const installed = manager.listConfiguredPackages().filter((entry) => !scopeSelected || entry.scope === scope);
    if (json) output(installed, true);
    else if (installed.length === 0) line("No packages installed.");
    else {
      for (const selectedScope of ["user", "project"] as const) {
        const entries = installed.filter((entry) => entry.scope === selectedScope);
        if (entries.length === 0) continue;
        line(`${selectedScope === "user" ? "User" : "Project"} packages:`);
        for (const entry of entries) {
          line(`  ${entry.source}${entry.filtered ? " (filtered)" : ""}`);
          if (entry.installedPath !== undefined) line(`    ${entry.installedPath}`);
        }
      }
    }
    return;
  }
  if (action === "install") {
    const source = argumentsValue.positionals[offset];
    if (source === undefined) throw new Error("install requires a package source: directory, npm:SPEC, git:SOURCE, or HTTPS URL");
    await manager.installAndPersist(source, { local: scope === "project", allowScripts });
    await settings.flush();
    const installed = manager.listConfiguredPackages().find((entry) => entry.scope === scope && entry.source === source)
      ?? { source, scope, filtered: false };
    if (json) output(installed, true);
    else line(`Installed ${source} (${scope})`);
    return;
  }
  if (action === "update") {
    const source = argumentsValue.positionals[offset];
    if (flagBoolean(argumentsValue, "all")) {
      if (source !== undefined) throw new Error("update accepts either a package source or --all, not both");
      await manager.update(undefined, { allowScripts });
      const updated = manager.listConfiguredPackages();
      if (json) output({ updated }, true);
      else line(`Updated ${updated.length} configured package${updated.length === 1 ? "" : "s"}.`);
      return;
    }
    if (source === undefined) throw new Error("update requires a package source or --all");
    await manager.update(source, { allowScripts });
    if (json) output({ source, updated: true }, true);
    else line(`Updated ${source}`);
    return;
  }
  if (action === "remove" || action === "uninstall") {
    const source = argumentsValue.positionals[offset];
    if (source === undefined) throw new Error("remove requires a package source");
    const removed = await manager.removeAndPersist(source, { local: scope === "project" });
    await settings.flush();
    if (json) output({ source, scope, removed }, true);
    else line(removed ? `Removed ${source} (${scope})` : `Package was not configured: ${source}`);
    return;
  }
  throw new Error(`Unknown package action: ${action}`);
}

export async function runProjectPackageCommand(
  argumentsValue: ParsedArguments,
  options: PackageCommandOptions = {},
): Promise<void> {
  const { paths, workspace, trusted, settings } = await packageContext(argumentsValue, options);
  const npmCommand = settings.getNpmCommand();
  const manager = new ProjectPackageManager({
    workspace,
    projectTrusted: trusted,
    ...(flagBoolean(argumentsValue, "offline") ? { offline: true } : {}),
    operationLeaseRoot: resolve(paths.agentDirectory, "state", "leases"),
    ...(npmCommand === undefined || npmCommand.length === 0 ? {} : {
      commands: { npm: { command: npmCommand[0]!, prefix: npmCommand.slice(1) } },
    }),
  });
  const action = argumentsValue.positionals[0] ?? "check";
  const json = flagBoolean(argumentsValue, "json");
  if (action === "check") {
    const result = await manager.check(options.signal);
    if (json) output(result, true);
    else line(result.message);
    return;
  }
  if (action === "reconcile") {
    const result = await manager.reconcile(options.signal);
    if (json) output(result, true);
    else if (result.status === "ignored") line("Project package declarations are ignored until the workspace is trusted.");
    else line(`${result.changed ? "Reconciled" : "Verified"} ${result.packages.length} locked project package${result.packages.length === 1 ? "" : "s"}.`);
    return;
  }
  if (action === "update") {
    if (flagBoolean(argumentsValue, "allow-scripts")) {
      throw new Error("Declarative project packages never enable lifecycle scripts");
    }
    const ids = argumentsValue.positionals.slice(1);
    const result = await manager.update({
      all: flagBoolean(argumentsValue, "all"),
      ids,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (json) output(result, true);
    else line(`Updated and reconciled ${result.packages.length} locked project package${result.packages.length === 1 ? "" : "s"}.`);
    return;
  }
  throw new Error(`Unknown project package action: ${action}`);
}

export interface ExtensionsCommandOptions {
  extensionFactories?: readonly RuntimeInlineExtension[];
  projectTrustResolver?: ProjectTrustResolver;
}

export async function runExtensionsCommand(
  argumentsValue: ParsedArguments,
  options: ExtensionsCommandOptions = {},
): Promise<void> {
  if (["install", "remove", "uninstall", "update", "packages"].includes(argumentsValue.positionals[0] ?? "")) {
    const action = argumentsValue.positionals[0] === "packages" ? "list" : argumentsValue.positionals[0]!;
    await runPackageCommand(
      { ...argumentsValue, positionals: [action, ...argumentsValue.positionals.slice(1)] },
      options.projectTrustResolver === undefined ? {} : { projectTrustResolver: options.projectTrustResolver },
    );
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
    ...(options.extensionFactories === undefined ? {} : { extensionFactories: options.extensionFactories }),
    ...(options.projectTrustResolver === undefined ? {} : { projectTrustResolver: options.projectTrustResolver }),
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
