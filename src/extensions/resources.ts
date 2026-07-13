import { relative, sep } from "node:path";

import type { ExtensionCatalog } from "./loader.js";
import type { ExtensionBundle, ExtensionMetadata } from "./types.js";
import { ExtensionCatalog as Catalog } from "./loader.js";

export type ExtensionResourceKind = "runtime" | "skill" | "prompt" | "command" | "theme";
export type ExtensionResourceFilters = Readonly<Record<string, readonly string[]>>;

export interface ExtensionResource {
  extensionId: string;
  extensionName: string;
  scope: ExtensionMetadata["scope"];
  kind: ExtensionResourceKind;
  key: string;
  label: string;
  sourcePath: string;
  enabled: boolean;
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  return value === "" ? "." : value;
}

function resourceKey(kind: ExtensionResourceKind, value: string): string {
  return `${kind}:${value}`;
}

function metadataById(catalog: ExtensionCatalog): Map<string, ExtensionMetadata> {
  return new Map(catalog.list().filter((entry) => entry.status === "active").map((entry) => [entry.id, entry]));
}

function disabledSet(filters: ExtensionResourceFilters, extensionId: string): Set<string> {
  return new Set(filters[extensionId] ?? []);
}

export function listExtensionResources(
  catalog: ExtensionCatalog,
  filters: ExtensionResourceFilters = {},
): ExtensionResource[] {
  const metadata = metadataById(catalog);
  const bundle = catalog.bundle();
  const resources: ExtensionResource[] = [];
  const add = (extensionId: string, kind: ExtensionResourceKind, value: string, label: string, sourcePath: string): void => {
    const extension = metadata.get(extensionId);
    if (extension === undefined) return;
    const key = resourceKey(kind, value);
    resources.push({
      extensionId,
      extensionName: extension.name,
      scope: extension.scope,
      kind,
      key,
      label,
      sourcePath,
      enabled: !disabledSet(filters, extensionId).has(key),
    });
  };
  for (const entry of bundle.runtime) {
    const extension = metadata.get(entry.extensionId);
    if (extension !== undefined) {
      const path = portableRelative(extension.extensionRoot, entry.sourcePath);
      add(entry.extensionId, "runtime", path, path, entry.sourcePath);
    }
  }
  for (const entry of bundle.skillRoots) {
    if (entry.extensionId === undefined) continue;
    const extension = metadata.get(entry.extensionId);
    if (extension !== undefined) {
      const path = portableRelative(extension.extensionRoot, entry.path);
      add(entry.extensionId, "skill", path, path, entry.path);
    }
  }
  for (const entry of bundle.prompts) add(entry.extensionId, "prompt", entry.id, entry.id, entry.sourcePath);
  for (const entry of bundle.commands) add(entry.extensionId, "command", entry.name, entry.name, entry.sourcePath);
  for (const entry of bundle.themes) add(entry.extensionId, "theme", entry.name, entry.name, entry.sourcePath);
  return resources.sort((left, right) =>
    left.scope.localeCompare(right.scope)
    || left.extensionId.localeCompare(right.extensionId)
    || left.kind.localeCompare(right.kind)
    || left.label.localeCompare(right.label));
}

export function filterExtensionResources(
  catalog: ExtensionCatalog,
  filters: ExtensionResourceFilters,
): ExtensionCatalog {
  const bundle = catalog.bundle();
  const enabled = (extensionId: string | undefined, key: string): boolean =>
    extensionId === undefined || !disabledSet(filters, extensionId).has(key);
  const metadata = metadataById(catalog);
  const relativeKey = (extensionId: string | undefined, kind: "runtime" | "skill", path: string): string => {
    const extension = extensionId === undefined ? undefined : metadata.get(extensionId);
    return resourceKey(kind, extension === undefined ? path : portableRelative(extension.extensionRoot, path));
  };
  const filtered: ExtensionBundle = {
    runtime: bundle.runtime.filter((entry) => enabled(entry.extensionId, relativeKey(entry.extensionId, "runtime", entry.sourcePath))),
    skillRoots: bundle.skillRoots.filter((entry) => enabled(entry.extensionId, relativeKey(entry.extensionId, "skill", entry.path))),
    prompts: bundle.prompts.filter((entry) => enabled(entry.extensionId, resourceKey("prompt", entry.id))),
    commands: bundle.commands.filter((entry) => enabled(entry.extensionId, resourceKey("command", entry.name))),
    themes: bundle.themes.filter((entry) => enabled(entry.extensionId, resourceKey("theme", entry.name))),
  };
  return new Catalog(catalog.list(), catalog.doctor().diagnostics, filtered);
}
