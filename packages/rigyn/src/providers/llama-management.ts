import type { TerminalPrompter } from "../interfaces/terminal.js";
import {
  discoverHuggingFaceToken,
  HuggingFaceGgufClient,
  type GgufModelDetails,
  type GgufSearchResult,
} from "./huggingface-gguf.js";
import {
  LlamaRouterClient,
  type LlamaRouterModel,
  type LlamaRouterProgress,
} from "./llama-router.js";

export interface LlamaRouterManagementOptions {
  terminal: TerminalPrompter;
  client: LlamaRouterClient;
  catalog?: HuggingFaceGgufClient;
  signal?: AbortSignal;
  onStatus?: (message?: string, progress?: LlamaRouterProgress) => void;
}

export interface LlamaRouterManagementResult {
  loaded: string[];
  unloaded: string[];
  downloaded: string[];
}

type MenuChoice =
  | { kind: "model"; model: LlamaRouterModel }
  | { kind: "download" }
  | { kind: "refresh" }
  | { kind: "close" };

function statusDetail(model: LlamaRouterModel): string {
  const context = model.contextTokens ?? model.trainingContextTokens;
  const contextText = context === undefined ? "" : ` · ${context.toLocaleString("en-US")} context`;
  return `${model.status.value}${contextText}`;
}

function splitRepositoryAndQuantization(value: string): { repository: string; quantization?: string } | undefined {
  const normalized = value.trim();
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash === normalized.length - 1) return undefined;
  const colon = normalized.lastIndexOf(":");
  if (colon <= slash) return { repository: normalized };
  const repository = normalized.slice(0, colon);
  const quantization = normalized.slice(colon + 1).trim().toUpperCase();
  return quantization === "" ? undefined : { repository, quantization };
}

async function chooseRepository(
  terminal: TerminalPrompter,
  catalog: HuggingFaceGgufClient,
  input: string,
  signal?: AbortSignal,
): Promise<{ details: GgufModelDetails; requestedQuantization?: string }> {
  const exact = splitRepositoryAndQuantization(input);
  if (exact !== undefined) {
    return {
      details: await catalog.details(exact.repository, signal),
      ...(exact.quantization === undefined ? {} : { requestedQuantization: exact.quantization }),
    };
  }
  const results = await catalog.search(input, signal);
  if (results.length === 0) throw new Error("No matching GGUF repositories were found");
  const selected = await terminal.choose<GgufSearchResult>("Select a model repository", results.map((result) => ({
    label: result.id,
    detail: `${result.downloads.toLocaleString("en-US")} downloads`,
    value: result,
  })), signal);
  return { details: await catalog.details(selected.id, signal) };
}

async function downloadModel(
  options: LlamaRouterManagementOptions,
  catalog: HuggingFaceGgufClient,
): Promise<{ id: string; load: boolean }> {
  const query = (await options.terminal.question("Search or owner/repository[:quantization]: ", options.signal)).trim();
  if (query === "") throw new Error("A model search or repository ID is required");
  options.onStatus?.("Looking up GGUF models…");
  const selected = await chooseRepository(options.terminal, catalog, query, options.signal);
  if (selected.details.gated !== false) {
    const accepted = await options.terminal.choose("This repository requires access approval", [
      { label: "Continue", detail: "Download only if the configured token has repository access", value: true },
      { label: "Cancel", value: false },
    ], options.signal);
    if (!accepted) throw new Error("Model download cancelled");
  }
  if (selected.details.quantizations.length === 0) throw new Error("The selected repository has no recognized GGUF quantizations");
  const quantization = selected.requestedQuantization ?? await options.terminal.choose(
    "Select a quantization",
    selected.details.quantizations.map((entry) => ({
      label: entry.name,
      ...(entry.sizeBytes === undefined ? {} : { detail: `${entry.sizeBytes.toLocaleString("en-US")} bytes` }),
      value: entry.name,
    })),
    options.signal,
  );
  if (!selected.details.quantizations.some((entry) => entry.name === quantization)) {
    throw new Error(`Quantization ${quantization} is not present in ${selected.details.id}`);
  }
  const id = `${selected.details.id}:${quantization}`;
  options.onStatus?.(`Downloading ${id}…`);
  try {
    await options.client.downloadAndWait(id, (progress) => options.onStatus?.(progress.message, progress), options.signal);
  } catch (cause) {
    if (options.signal?.aborted === true) {
      await options.client.unload(id, AbortSignal.timeout(15_000)).catch(() => undefined);
    }
    throw cause;
  }
  const load = await options.terminal.choose("Load the downloaded model now?", [
    { label: "Load model", value: true },
    { label: "Keep unloaded", value: false },
  ], options.signal);
  return { id, load };
}

async function loadModel(
  options: LlamaRouterManagementOptions,
  model: LlamaRouterModel,
  current: readonly LlamaRouterModel[],
  result: LlamaRouterManagementResult,
): Promise<void> {
  const loaded = current.filter((entry) => entry.id !== model.id
    && (entry.status.value === "loaded" || entry.status.value === "sleeping"));
  const replaced: LlamaRouterModel[] = [];
  if (loaded.length > 0) {
    const action = await options.terminal.choose("Other models are loaded", [
      { label: "Keep them loaded", detail: "The router may use more memory", value: "keep" as const },
      { label: "Unload other models", detail: loaded.map((entry) => entry.id).join(", "), value: "unload" as const },
      { label: "Cancel", value: "cancel" as const },
    ], options.signal);
    if (action === "cancel") return;
    if (action === "unload") {
      for (const entry of loaded) {
        options.onStatus?.(`Unloading ${entry.id}…`);
        await options.client.unloadAndWait(entry.id, options.signal);
        result.unloaded.push(entry.id);
        replaced.push(entry);
      }
    }
  }
  try {
    options.onStatus?.(`Loading ${model.id}…`);
    await options.client.loadAndWait(model.id, (progress) => options.onStatus?.(progress.message, progress), options.signal);
    result.loaded.push(model.id);
  } catch (cause) {
    if (options.signal?.aborted === true) {
      await options.client.unload(model.id, AbortSignal.timeout(15_000)).catch(() => undefined);
    }
    let restoreFailure: unknown;
    for (const entry of replaced) {
      try {
        options.onStatus?.(`Restoring ${entry.id}…`);
        await options.client.loadAndWait(entry.id, undefined, AbortSignal.timeout(120_000));
        const index = result.unloaded.indexOf(entry.id);
        if (index >= 0) result.unloaded.splice(index, 1);
      } catch (error) {
        restoreFailure ??= error;
      }
    }
    if (restoreFailure !== undefined && options.signal?.aborted !== true) {
      const original = cause instanceof Error ? cause.message : String(cause);
      const restoration = restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure);
      throw new Error(`${original}; restoring the previously loaded model also failed: ${restoration}`, { cause });
    }
    throw cause;
  }
}

export async function manageLlamaRouter(options: LlamaRouterManagementOptions): Promise<LlamaRouterManagementResult> {
  const result: LlamaRouterManagementResult = { loaded: [], unloaded: [], downloaded: [] };
  let catalog = options.catalog;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      options.onStatus?.("Refreshing local models…");
      let models: LlamaRouterModel[];
      try {
        models = await options.client.list({
          reload: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause) {
        options.onStatus?.();
        options.signal?.throwIfAborted();
        const action = await options.terminal.choose("Local router unavailable", [
          {
            label: "Retry",
            detail: cause instanceof Error ? cause.message : String(cause),
            value: "retry" as const,
          },
          { label: "Close", value: "close" as const },
        ], options.signal);
        if (action === "close") return result;
        continue;
      }
      options.onStatus?.();
      models.sort((left, right) => {
        const leftActive = left.status.value === "loaded" || left.status.value === "sleeping";
        const rightActive = right.status.value === "loaded" || right.status.value === "sleeping";
        return Number(rightActive) - Number(leftActive) || left.id.localeCompare(right.id);
      });
      const selected = await options.terminal.choose<MenuChoice>("Local models", [
        ...models.map((model) => ({ label: model.id, detail: statusDetail(model), value: { kind: "model", model } as const })),
        { label: "Download model…", detail: "Search public GGUF repositories or enter an exact ID", value: { kind: "download" } },
        { label: "Refresh", value: { kind: "refresh" } },
        { label: "Close", value: { kind: "close" } },
      ], options.signal);
      if (selected.kind === "close") return result;
      if (selected.kind === "refresh") continue;
      if (selected.kind === "download") {
        const token = await discoverHuggingFaceToken();
        catalog ??= new HuggingFaceGgufClient(token === undefined ? {} : { token });
        const downloaded = await downloadModel(options, catalog);
        result.downloaded.push(downloaded.id);
        if (downloaded.load) {
          await loadModel(options, { id: downloaded.id, status: { value: "unloaded" } }, models, result);
        }
        continue;
      }
      const status = selected.model.status.value;
      if (status === "loaded" || status === "sleeping") {
        const unload = await options.terminal.choose(`Unload ${selected.model.id}?`, [
          { label: "Unload", value: true },
          { label: "Cancel", value: false },
        ], options.signal);
        if (unload) {
          options.onStatus?.(`Unloading ${selected.model.id}…`);
          await options.client.unloadAndWait(selected.model.id, options.signal);
          result.unloaded.push(selected.model.id);
        }
        continue;
      }
      if (status === "unloaded") {
        await loadModel(options, selected.model, models, result);
        continue;
      }
      options.onStatus?.(`${selected.model.id} is currently ${status}`);
    }
  } finally {
    options.onStatus?.();
  }
}
