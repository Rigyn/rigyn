import { relative } from "node:path";

import type { AgentSession } from "../service/agent-session.js";

function resourcePath(path: string, cwd: string): string {
  const selected = relative(cwd, path);
  return selected !== "" && !selected.startsWith("..") ? `./${selected}` : path;
}

function resourceRows(label: string, values: readonly string[], maximum = 12): string[] {
  if (values.length === 0) return [`${label} (0)`];
  const shown = values.slice(0, maximum).map((value) => `  ${value}`);
  if (values.length > maximum) shown.push(`  … ${values.length - maximum} more`);
  return [`${label} (${values.length})`, ...shown];
}

/** Render the resource provenance reported by the interactive `/resources` command. */
export function renderInteractiveResourceReport(session: AgentSession, cwd: string): string {
  const loader = session.resourceLoader;
  const commands = session.extensionRunner.getRegisteredCommands();
  const prompts = loader.getPrompts();
  const skills = loader.getSkills();
  const themes = loader.getThemes();
  const packages = loader.getProjectPackageState?.();
  const source = (value: { path: string; scope: string; source: string }) =>
    `${value.scope}:${value.source} · ${resourcePath(value.path, cwd)}`;
  const diagnostics = [
    ...prompts.diagnostics,
    ...skills.diagnostics,
    ...themes.diagnostics,
    ...session.extensionRunner.getCommandDiagnostics(),
  ];
  return [
    "Loaded resources",
    ...resourceRows("Extensions", session.extensionRunner.getExtensionPaths().map((path) => resourcePath(path, cwd))),
    ...resourceRows("Commands", commands.map((command) =>
      `/${command.invocationName} ← ${source(command.sourceInfo)}`)),
    ...resourceRows("Prompts", prompts.prompts.map((prompt) =>
      `/${prompt.name} ← ${source(prompt.sourceInfo)}`)),
    ...resourceRows("Skills", skills.skills.map((skill) =>
      `${skill.name} ← ${source(skill.sourceInfo)}`)),
    ...resourceRows("Themes", themes.themes.map((theme) =>
      `${theme.name} ← ${theme.extensionId} · ${resourcePath(theme.sourcePath, cwd)}`)),
    ...resourceRows("Instruction files", loader.getAgentsFiles().agentsFiles.map((entry) =>
      resourcePath(entry.path, cwd))),
    ...resourceRows("Project packages", (packages?.packages ?? []).map((entry) => {
      const selected = entry.provenance;
      const origin = selected.kind === "local"
        ? resourcePath(selected.sourcePath, cwd)
        : selected.kind === "git"
          ? `${selected.source}@${selected.revision}`
          : `${selected.packageName}@${selected.resolvedVersion}`;
      return `${entry.name}${entry.version === undefined ? "" : `@${entry.version}`} ← ${selected.kind}:${origin}`;
    })),
    ...(diagnostics.length === 0
      ? []
      : resourceRows("Diagnostics", diagnostics.map((entry) =>
          `${entry.type}: ${entry.message}${entry.path === undefined ? "" : ` · ${resourcePath(entry.path, cwd)}`}`))),
  ].join("\n");
}
