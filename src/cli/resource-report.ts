import type { HarnessResourceCatalog } from "../service/resource-catalog.js";

function countScopes<T extends { scope: string }>(entries: readonly T[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.scope, (counts.get(entry.scope) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([scope, count]) => `${scope} ${count}`)
    .join(", ");
}

export function formatResourceCatalogReport(catalog: HarnessResourceCatalog): string {
  const commands = catalog.commands.builtins.length
    + catalog.commands.runtimeExtensions.length
    + catalog.commands.extensionTemplates.length;
  const models = catalog.providers.reduce((sum, provider) => sum + provider.models.length, 0);
  const activeExtensions = catalog.extensions.filter((entry) => entry.status === "active").length;
  const packageScopes = countScopes(catalog.packages);
  const extensionScopes = countScopes(catalog.extensions);
  const omitted = Object.values(catalog.bounds.omitted).reduce((sum, count) => sum + count, 0);
  return [
    "Resource catalog",
    `Tools: ${catalog.tools.length} · Commands: ${commands} · Skills: ${catalog.skills.length} · Prompts: ${catalog.prompts.length} · Themes: ${catalog.themes.length}`,
    `Providers: ${catalog.providers.length} · Models: ${models}`,
    `Packages: ${catalog.packages.length}${packageScopes === "" ? "" : ` (${packageScopes})`}`,
    `Extensions: ${catalog.extensions.length} · Active: ${activeExtensions}${extensionScopes === "" ? "" : ` (${extensionScopes})`}`,
    `Diagnostics: ${catalog.diagnostics.length}${catalog.bounds.truncated ? ` · Catalog bounded; ${omitted} entries omitted` : ""}`,
  ].join("\n");
}
