import {
  appendDirectExtensions,
  loadDirectExtensions,
  type RuntimeDirectPathMetadata,
  type RuntimeExtensionHost,
  type RuntimeExtensionLoadOptions,
} from "../../src/extensions/runtime.js";
import type { ExtensionRuntimeEntry } from "../../src/extensions/types.js";

function metadata(entries: readonly ExtensionRuntimeEntry[]): ReadonlyMap<string, RuntimeDirectPathMetadata> {
  return new Map(entries.map((entry) => [entry.sourcePath, {
    scope: entry.scope === "invocation" || entry.scope === "builtin" || entry.scope === undefined
      ? "temporary" as const
      : entry.scope,
    trusted: entry.trusted ?? true,
    ...(entry.resourceRoot === undefined ? {} : { resourceRoot: entry.resourceRoot }),
    extensionId: entry.extensionId,
    expectedSha256: entry.sha256,
  }]));
}

/** Exercises the path-first direct loader while retaining explicit fixture provenance. */
export async function loadTestDirectExtensions(
  entries: readonly ExtensionRuntimeEntry[],
  options: RuntimeExtensionLoadOptions,
): Promise<RuntimeExtensionHost> {
  const { directPathMetadata: _directPathMetadata, ...loadOptions } = options;
  return await loadDirectExtensions(entries.map((entry) => entry.sourcePath), {
    ...loadOptions,
    directPathMetadata: metadata(entries),
  });
}

/** Appends fixtures through the same path-first direct loader used by reload. */
export async function appendTestDirectExtensions(
  host: RuntimeExtensionHost,
  entries: readonly ExtensionRuntimeEntry[],
  options: RuntimeExtensionLoadOptions,
): Promise<void> {
  const { directPathMetadata: _directPathMetadata, ...loadOptions } = options;
  await appendDirectExtensions(host, entries.map((entry) => entry.sourcePath), {
    ...loadOptions,
    directPathMetadata: metadata(entries),
  });
}
