#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createModelDataManifest,
  MODEL_DATA_MANIFEST_FILE,
  readModelDataStructure,
  validateGeneratedModelData,
  validateModelDataDirectory,
} from "../packages/models/scripts/model-data.mjs";
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  canonicalProviderId,
} from "../packages/rigyn/src/providers/builtins.js";
import { MAINTAINED_MODEL_CATALOG } from "../packages/rigyn/src/providers/maintained-model-catalog.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT_ROOT = resolve(REPOSITORY_ROOT, "packages/rigyn");
const PRODUCT_OUTPUT_PATH = resolve(PRODUCT_ROOT, "src/providers/builtin-models.generated.ts");
const PACKAGE_ROOT = resolve(REPOSITORY_ROOT, "packages/models");
const PACKAGE_OUTPUT_PATH = resolve(PACKAGE_ROOT, "src/models.generated.ts");
const PACKAGE_PROVIDERS_DIR = resolve(PACKAGE_ROOT, "src/providers");
const PACKAGE_DATA_DIR = resolve(PACKAGE_PROVIDERS_DIR, "data");
const EXPECTED_MAINTAINED_MODEL_COUNT = 157;
const EXPECTED_DIRECT_MODEL_COUNT = 11;
const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PACKAGE_PROVIDER_IDS = Object.freeze(BUILTIN_PROVIDER_DESCRIPTORS
  .map((descriptor) => descriptor.id)
  .filter((providerId) => providerId !== "radius")
  .sort());

const PACKAGE_API_BY_PROTOCOL = Object.freeze({
  "bedrock-converse": "bedrock-converse-stream",
  "gemini-generate-content": "google-generative-ai",
  "openai-chat-completions": "openai-completions",
});

function modelKey(model) {
  return `${model.provider}/${model.id}`;
}

function providerDescriptor(providerId) {
  const canonical = canonicalProviderId(providerId);
  return BUILTIN_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.id === canonical);
}

export function validateMaintainedCatalog(models) {
  if (!Array.isArray(models) || models.length !== EXPECTED_MAINTAINED_MODEL_COUNT) {
    throw new Error(`Rigyn's maintained catalog must contain ${EXPECTED_MAINTAINED_MODEL_COUNT} models; received ${models?.length ?? "invalid input"}`);
  }
  const keys = new Set();
  for (const model of models) {
    if (typeof model?.provider !== "string" || model.provider.trim() === "" || typeof model.id !== "string" || model.id.trim() === "") {
      throw new Error("Rigyn's maintained catalog contains an invalid provider or model ID");
    }
    const key = modelKey(model);
    if (keys.has(key)) throw new Error(`Rigyn's maintained catalog contains a duplicate: ${key}`);
    keys.add(key);
    if (model.metadataSource !== "maintained") throw new Error(`Rigyn's maintained catalog has an invalid metadata source at ${key}`);
    if (providerDescriptor(model.provider) === undefined) throw new Error(`Rigyn's maintained catalog uses an unknown provider: ${model.provider}`);
  }
}

function finiteRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function losslessPricing(pricing) {
  if (pricing === undefined || pricing.validUntil !== undefined) return undefined;
  if (![pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite].every(finiteRate)) return undefined;
  const tiers = pricing.tiers ?? [];
  if (tiers.some((tier) =>
    !Number.isSafeInteger(tier.minimumInputTokens) || tier.minimumInputTokens < 1 ||
    tier.maximumInputTokens !== undefined ||
    ![tier.input, tier.output, tier.cacheRead, tier.cacheWrite].every(finiteRate))) return undefined;
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cacheRead,
    cacheWrite: pricing.cacheWrite,
    ...(tiers.length === 0
      ? {}
      : { tiers: tiers.map((tier) => ({
          inputTokensAbove: tier.minimumInputTokens - 1,
          input: tier.input,
          output: tier.output,
          cacheRead: tier.cacheRead,
          cacheWrite: tier.cacheWrite,
        })) }),
  };
}

function thinkingLevelMap(model) {
  if (model.reasoning !== true) return undefined;
  const supported = new Set(model.reasoningEfforts ?? THINKING_LEVELS);
  return Object.fromEntries(THINKING_LEVELS.map((level) => [
    level,
    !supported.has(level) || model.reasoningEffortMap?.[level] === null
      ? null
      : model.reasoningEffortMap?.[level] ?? level,
  ]));
}

function projectMaintainedModel(model) {
  const descriptor = providerDescriptor(model.provider);
  const cost = losslessPricing(model.pricing);
  if (
    descriptor?.baseUrl === undefined || descriptor.apis.length !== 1 || cost === undefined ||
    !Number.isSafeInteger(model.contextTokens) || model.contextTokens < 1 ||
    !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 ||
    typeof model.reasoning !== "boolean" || typeof model.images !== "boolean" ||
    model.requestCompatibility !== undefined
  ) return undefined;
  const map = thinkingLevelMap(model);
  return {
    id: model.id,
    name: model.displayName ?? model.id,
    api: descriptor.apis[0],
    provider: descriptor.id,
    baseUrl: descriptor.baseUrl,
    reasoning: model.reasoning,
    ...(map === undefined ? {} : { thinkingLevelMap: map }),
    input: model.images ? ["text", "image"] : ["text"],
    cost,
    contextWindow: model.contextTokens,
    maxTokens: model.maxOutputTokens,
    ...(model.headers === undefined ? {} : { headers: model.headers }),
  };
}

export function projectMaintainedModels(models) {
  const projected = models.flatMap((model) => {
    const direct = projectMaintainedModel(model);
    return direct === undefined ? [] : [direct];
  });
  if (projected.length !== EXPECTED_DIRECT_MODEL_COUNT) {
    throw new Error(`Rigyn's strict direct-model projection must contain ${EXPECTED_DIRECT_MODEL_COUNT} models; received ${projected.length}`);
  }
  return projected;
}

function packageModel(model) {
  const api = PACKAGE_API_BY_PROTOCOL[model.api] ?? model.api;
  return api === model.api ? model : { ...model, api };
}

export function parseGeneratorOptions(args) {
  const options = { check: false, checkData: false, dataOnly: false, strict: false };
  for (const arg of args) {
    if (arg === "--check") options.check = true;
    else if (arg === "--check-data") options.checkData = true;
    else if (arg === "--data-only") options.dataOnly = true;
    else if (arg === "--strict") options.strict = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const selectedModes = [options.check, options.checkData, options.dataOnly].filter(Boolean).length;
  if (selectedModes > 1) throw new Error("--check, --check-data, and --data-only are mutually exclusive");
  if (options.dataOnly && !options.strict) throw new Error("--data-only requires --strict");
  return options;
}

export function renderRootCatalog(models) {
  const entries = models.map((entry) => `  model(${JSON.stringify(entry, null, 2).replaceAll("\n", "\n  ")}),`).join("\n");
  return `// Generated by scripts/generate-provider-models.mjs from Rigyn's maintained catalog. Do not edit.
import type { ProviderModel } from "./models.js";

function model(value: ProviderModel): ProviderModel {
  return value;
}

const MODELS: ProviderModel[] = [
${entries}
];

export const BUILTIN_MODEL_CATALOG: readonly ProviderModel[] = Object.freeze(MODELS);
`;
}

function catalogConstName(providerId) {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODELS`;
}

function renderProviderShard(providerId, models) {
  const shapes = models.map((model) => `  ${JSON.stringify(model.id)}: Model<${JSON.stringify(model.api)}> & {
    id: ${JSON.stringify(model.id)};
    provider: ${JSON.stringify(providerId)};
  };`).join("\n");
  return `// Generated by scripts/generate-provider-models.mjs from Rigyn's maintained catalog. Do not edit.
import values from "./data/${providerId}.json" with { type: "json" };
import type { Model } from "../types.js";

export const ${catalogConstName(providerId)} = Object.freeze(values) as Readonly<{
${shapes}
}>;
`;
}

function renderPackageAggregator(providerIds) {
  const imports = providerIds.map((providerId) => `import { ${catalogConstName(providerId)} } from "./providers/${providerId}.models.js";`).join("\n");
  const providers = providerIds.map((providerId) => `  ${JSON.stringify(providerId)}: ${catalogConstName(providerId)},`).join("\n");
  return `// Generated by scripts/generate-provider-models.mjs from Rigyn's maintained catalog. Do not edit.
import type { Api, Model } from "./types.js";
${imports}

export const MODELS = Object.freeze({
${providers}
});

const MODEL_ENTRIES = Object.values(MODELS).flatMap((models) => Object.values(models)) as Model<Api>[];
export const BUILTIN_MODEL_CATALOG: readonly Model<Api>[] = Object.freeze(MODEL_ENTRIES);
`;
}

function serializeJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function createPackageOutputs(models) {
  const grouped = new Map(PACKAGE_PROVIDER_IDS.map((providerId) => [providerId, []]));
  for (const source of models) {
    const model = packageModel(source);
    const provider = grouped.get(model.provider);
    if (provider === undefined) throw new Error(`Direct model projection uses unknown package provider ${model.provider}`);
    provider.push(model);
  }
  const providerIds = [...PACKAGE_PROVIDER_IDS];
  const structure = {};
  const shards = new Map();
  const data = new Map();
  for (const providerId of providerIds) {
    const providerModels = grouped.get(providerId).sort((left, right) => left.id.localeCompare(right.id));
    structure[providerId] = Object.fromEntries(providerModels.map((model) => [model.id, model.api]));
    shards.set(`${providerId}.models.ts`, renderProviderShard(providerId, providerModels));
    data.set(`${providerId}.json`, serializeJson(Object.fromEntries(providerModels.map((model) => [model.id, model]))));
  }
  const manifest = createModelDataManifest(structure, Object.fromEntries(data));
  data.set(MODEL_DATA_MANIFEST_FILE, serializeJson(manifest));
  return { aggregator: renderPackageAggregator(providerIds), data, providerIds, shards, structure };
}

function verifyFile(path, expected, drift) {
  if (!existsSync(path) || readFileSync(path, "utf8").replaceAll("\r\n", "\n") !== expected) drift.push(path);
}

function verifyGeneratedOutputs(rootOutput, packageOutputs) {
  const drift = [];
  verifyFile(PRODUCT_OUTPUT_PATH, rootOutput, drift);
  verifyFile(PACKAGE_OUTPUT_PATH, packageOutputs.aggregator, drift);
  for (const [filename, content] of packageOutputs.shards) verifyFile(join(PACKAGE_PROVIDERS_DIR, filename), content, drift);
  for (const [filename, content] of packageOutputs.data) verifyFile(join(PACKAGE_DATA_DIR, filename), content, drift);
  const expectedShards = [...packageOutputs.shards.keys()].sort();
  const actualShards = readdirSync(PACKAGE_PROVIDERS_DIR).filter((entry) => entry.endsWith(".models.ts")).sort();
  if (JSON.stringify(expectedShards) !== JSON.stringify(actualShards)) drift.push(PACKAGE_PROVIDERS_DIR);
  const expectedData = [...packageOutputs.data.keys()].sort();
  const actualData = existsSync(PACKAGE_DATA_DIR) ? readdirSync(PACKAGE_DATA_DIR).sort() : [];
  if (JSON.stringify(expectedData) !== JSON.stringify(actualData)) drift.push(PACKAGE_DATA_DIR);
  return [...new Set(drift)];
}

function stageData(packageOutputs) {
  const stagingRoot = mkdtempSync(join(PACKAGE_PROVIDERS_DIR, ".model-data-"));
  const stagedDataDir = join(stagingRoot, "data");
  try {
    mkdirSync(stagedDataDir);
    for (const [filename, content] of packageOutputs.data) writeFileSync(join(stagedDataDir, filename), content);
    validateModelDataDirectory(packageOutputs.structure, stagedDataDir);
    return { stagedDataDir, stagingRoot };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function replaceDirectoryAtomically(currentDir, stagedDir, backupDir, validate) {
  const hadPrevious = existsSync(currentDir);
  if (hadPrevious) renameSync(currentDir, backupDir);
  try {
    renameSync(stagedDir, currentDir);
    validate();
    rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    rmSync(currentDir, { recursive: true, force: true });
    if (hadPrevious && existsSync(backupDir)) renameSync(backupDir, currentDir);
    throw error;
  }
}

function writeStructuralCatalog(rootOutput, packageOutputs) {
  const previousAggregator = existsSync(PACKAGE_OUTPUT_PATH) ? readFileSync(PACKAGE_OUTPUT_PATH, "utf8") : undefined;
  const previousShards = new Map(readdirSync(PACKAGE_PROVIDERS_DIR)
    .filter((entry) => entry.endsWith(".models.ts"))
    .map((entry) => [entry, readFileSync(join(PACKAGE_PROVIDERS_DIR, entry), "utf8")]));
  const previousRoot = existsSync(PRODUCT_OUTPUT_PATH) ? readFileSync(PRODUCT_OUTPUT_PATH, "utf8") : undefined;
  const restore = () => {
    for (const entry of readdirSync(PACKAGE_PROVIDERS_DIR)) if (entry.endsWith(".models.ts")) rmSync(join(PACKAGE_PROVIDERS_DIR, entry));
    for (const [entry, content] of previousShards) writeFileSync(join(PACKAGE_PROVIDERS_DIR, entry), content);
    if (previousAggregator === undefined) rmSync(PACKAGE_OUTPUT_PATH, { force: true });
    else writeFileSync(PACKAGE_OUTPUT_PATH, previousAggregator);
    if (previousRoot === undefined) rmSync(PRODUCT_OUTPUT_PATH, { force: true });
    else writeFileSync(PRODUCT_OUTPUT_PATH, previousRoot);
  };
  try {
    for (const [filename, content] of packageOutputs.shards) writeFileSync(join(PACKAGE_PROVIDERS_DIR, filename), content);
    for (const entry of readdirSync(PACKAGE_PROVIDERS_DIR)) {
      if (entry.endsWith(".models.ts") && !packageOutputs.shards.has(entry)) rmSync(join(PACKAGE_PROVIDERS_DIR, entry));
    }
    writeFileSync(PACKAGE_OUTPUT_PATH, packageOutputs.aggregator);
    writeFileSync(PRODUCT_OUTPUT_PATH, rootOutput);
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}

function hydrateDataOnly(packageOutputs) {
  const committedStructure = readModelDataStructure(PACKAGE_ROOT);
  if (JSON.stringify(committedStructure) !== JSON.stringify(packageOutputs.structure)) {
    throw new Error("Cannot hydrate model data because the committed structural catalog does not match the maintained projection");
  }
  const staged = stageData(packageOutputs);
  try {
    replaceDirectoryAtomically(
      PACKAGE_DATA_DIR,
      staged.stagedDataDir,
      join(staged.stagingRoot, "previous-data"),
      () => validateGeneratedModelData(PACKAGE_ROOT),
    );
  } finally {
    rmSync(staged.stagingRoot, { recursive: true, force: true });
  }
}

function generateAll(rootOutput, packageOutputs) {
  const staged = stageData(packageOutputs);
  let restoreStructure;
  try {
    restoreStructure = writeStructuralCatalog(rootOutput, packageOutputs);
    replaceDirectoryAtomically(
      PACKAGE_DATA_DIR,
      staged.stagedDataDir,
      join(staged.stagingRoot, "previous-data"),
      () => validateGeneratedModelData(PACKAGE_ROOT),
    );
    restoreStructure = undefined;
  } catch (error) {
    restoreStructure?.();
    throw error;
  } finally {
    rmSync(staged.stagingRoot, { recursive: true, force: true });
  }
}

export function main(args) {
  const options = parseGeneratorOptions(args);
  if (options.checkData) {
    validateGeneratedModelData(PACKAGE_ROOT);
    process.stdout.write("Verified generated provider model data.\n");
    return;
  }
  validateMaintainedCatalog(MAINTAINED_MODEL_CATALOG);
  const directModels = projectMaintainedModels(MAINTAINED_MODEL_CATALOG);
  const rootOutput = renderRootCatalog(directModels);
  const packageOutputs = createPackageOutputs(directModels);
  if (options.check) {
    const drift = verifyGeneratedOutputs(rootOutput, packageOutputs);
    if (drift.length) throw new Error(`Generated maintained-model projection drifted:\n${drift.map((path) => `- ${path}`).join("\n")}\nRun npm run generate:provider-models.`);
    validateGeneratedModelData(PACKAGE_ROOT);
    process.stdout.write(`Verified ${MAINTAINED_MODEL_CATALOG.length} maintained models, ${directModels.length} strict direct models, and ${packageOutputs.providerIds.length} provider shards.\n`);
    return;
  }
  if (options.dataOnly) hydrateDataOnly(packageOutputs);
  else generateAll(rootOutput, packageOutputs);
  process.stdout.write(`${options.dataOnly ? "Hydrated" : "Generated"} ${directModels.length} strict direct models from ${MAINTAINED_MODEL_CATALOG.length} maintained entries in ${packageOutputs.providerIds.length} provider shards.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
