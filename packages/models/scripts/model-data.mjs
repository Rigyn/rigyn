import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MODEL_DATA_SCHEMA_VERSION = 1;
export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";

const JSON_STRING_PATTERN = '"(?:\\\\.|[^"\\\\])*"';
const MODEL_SHAPE_PATTERN = new RegExp(`^  (${JSON_STRING_PATTERN}): Model<(${JSON_STRING_PATTERN})> & \\{$`);
const MODEL_ID_PATTERN = new RegExp(`^    id: (${JSON_STRING_PATTERN});$`);
const MODEL_PROVIDER_PATTERN = new RegExp(`^    provider: (${JSON_STRING_PATTERN});$`);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedRecord(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function describeDifference(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  return [missing.length ? `missing: ${missing.join(", ")}` : "", extra.length ? `extra: ${extra.join(", ")}` : ""]
    .filter(Boolean)
    .join("; ");
}

function parseJsonString(value, description) {
  const parsed = JSON.parse(value);
  if (typeof parsed !== "string") throw new Error(`${description} is not a string`);
  return parsed;
}

function parseProviderStructure(path, providerId) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(`import values from "./data/${providerId}.json" with { type: "json" };`)) {
    throw new Error(`${path} does not import ${providerId}.json`);
  }
  const models = new Map();
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const shape = MODEL_SHAPE_PATTERN.exec(lines[index]);
    if (!shape) continue;
    const id = MODEL_ID_PATTERN.exec(lines[index + 1] ?? "");
    const provider = MODEL_PROVIDER_PATTERN.exec(lines[index + 2] ?? "");
    if (!id || !provider || lines[index + 3] !== "  };") {
      throw new Error(`${path}:${index + 1} has a malformed generated model declaration`);
    }
    const key = parseJsonString(shape[1], `${path}:${index + 1} model key`);
    const api = parseJsonString(shape[2], `${path}:${index + 1} model API`);
    const modelId = parseJsonString(id[1], `${path}:${index + 2} model ID`);
    const declaredProvider = parseJsonString(provider[1], `${path}:${index + 3} provider ID`);
    if (modelId !== key) throw new Error(`${path}:${index + 1} declares key ${key} with ID ${modelId}`);
    if (declaredProvider !== providerId) throw new Error(`${path}:${index + 1} declares provider ${declaredProvider}`);
    if (models.has(key)) throw new Error(`${path} declares model ${key} more than once`);
    models.set(key, api);
    index += 3;
  }
  return sortedRecord(models);
}

export function readModelDataStructure(packageRoot) {
  const providersDir = join(packageRoot, "src", "providers");
  const shardProviderIds = readdirSync(providersDir)
    .filter((entry) => entry.endsWith(".models.ts"))
    .map((entry) => entry.slice(0, -".models.ts".length))
    .sort();
  if (shardProviderIds.length === 0) throw new Error(`No generated provider shards found under ${providersDir}`);
  const aggregator = readFileSync(join(packageRoot, "src", "models.generated.ts"), "utf8");
  const importedProviderIds = [...aggregator.matchAll(
    /^import \{ [A-Z0-9_]+_MODELS \} from "\.\/providers\/([^"/]+)\.models\.js";$/gm,
  )].map((match) => match[1]).sort();
  if (!sameStrings(shardProviderIds, importedProviderIds)) {
    throw new Error(`Generated model aggregator and provider shards do not match (${describeDifference(shardProviderIds, importedProviderIds)})`);
  }
  return sortedRecord(shardProviderIds.map((providerId) => [
    providerId,
    parseProviderStructure(join(providersDir, `${providerId}.models.ts`), providerId),
  ]));
}

export function modelDataStructureHash(structure) {
  return sha256(JSON.stringify(structure));
}

export function createModelDataManifest(structure, fileContents) {
  return {
    schemaVersion: MODEL_DATA_SCHEMA_VERSION,
    structureHash: modelDataStructureHash(structure),
    files: sortedRecord(Object.entries(fileContents).map(([file, content]) => [file, sha256(content)])),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(path, description, errors) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("must contain a JSON object");
    return parsed;
  } catch (error) {
    errors.push(`${description} is not valid: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function validateModelValue(value, providerId, modelId, expectedApi, errors) {
  const label = `${providerId}/${modelId}`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (value.id !== modelId) errors.push(`${label} has id ${JSON.stringify(value.id)}, expected ${JSON.stringify(modelId)}`);
  if (value.provider !== providerId) errors.push(`${label} has provider ${JSON.stringify(value.provider)}, expected ${JSON.stringify(providerId)}`);
  if (value.api !== expectedApi) errors.push(`${label} has api ${JSON.stringify(value.api)}, expected ${JSON.stringify(expectedApi)}`);
  if (typeof value.name !== "string" || value.name.length === 0) errors.push(`${label} has no model name`);
  if (typeof value.baseUrl !== "string") errors.push(`${label} has no baseUrl string`);
  if (typeof value.reasoning !== "boolean") errors.push(`${label} has no reasoning boolean`);
  if (!Array.isArray(value.input) || value.input.length === 0 || value.input.some((entry) => entry !== "text" && entry !== "image")) {
    errors.push(`${label} has invalid input modalities`);
  }
  if (!Number.isFinite(value.contextWindow) || value.contextWindow <= 0) errors.push(`${label} has invalid contextWindow`);
  if (!Number.isFinite(value.maxTokens) || value.maxTokens <= 0) errors.push(`${label} has invalid maxTokens`);
  if (!isRecord(value.cost)) errors.push(`${label} has invalid cost metadata`);
  else for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!Number.isFinite(value.cost[field])) errors.push(`${label} has invalid cost.${field}`);
  }
}

export function validateModelDataDirectory(structure, dataDir) {
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
    throw new Error(`Generated model data directory does not exist: ${dataDir}`);
  }
  const errors = [];
  const expectedFiles = Object.keys(structure).map((providerId) => `${providerId}.json`).sort();
  const actualFiles = readdirSync(dataDir).filter((entry) => entry.endsWith(".json") && entry !== MODEL_DATA_MANIFEST_FILE).sort();
  if (!sameStrings(expectedFiles, actualFiles)) errors.push(`provider data files do not match the structural catalog (${describeDifference(expectedFiles, actualFiles)})`);
  const manifest = readJsonObject(join(dataDir, MODEL_DATA_MANIFEST_FILE), "model data manifest", errors);
  if (manifest?.schemaVersion !== MODEL_DATA_SCHEMA_VERSION) errors.push(`model data schema is ${JSON.stringify(manifest?.schemaVersion)}, expected ${MODEL_DATA_SCHEMA_VERSION}`);
  if (manifest?.structureHash !== modelDataStructureHash(structure)) errors.push("model data generation stamp does not match the structural catalog");
  const manifestFiles = isRecord(manifest?.files) ? manifest.files : undefined;
  if (!manifestFiles) errors.push("model data manifest has no file hashes");
  else if (!sameStrings(expectedFiles, Object.keys(manifestFiles).sort())) errors.push(`manifest file hashes do not match provider data files (${describeDifference(expectedFiles, Object.keys(manifestFiles).sort())})`);
  for (const [providerId, expectedModels] of Object.entries(structure)) {
    const filename = `${providerId}.json`;
    const path = join(dataDir, filename);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    if (manifestFiles?.[filename] !== sha256(content)) errors.push(`${filename} does not match its manifest hash`);
    const values = readJsonObject(path, filename, errors);
    if (!values) continue;
    const expectedIds = Object.keys(expectedModels).sort();
    const actualIds = Object.keys(values).sort();
    if (!sameStrings(expectedIds, actualIds)) errors.push(`${filename} model IDs do not match the structural catalog (${describeDifference(expectedIds, actualIds)})`);
    for (const [modelId, api] of Object.entries(expectedModels)) {
      if (modelId in values) validateModelValue(values[modelId], providerId, modelId, api, errors);
    }
  }
  if (errors.length) {
    const visible = errors.slice(0, 30);
    const suffix = errors.length > visible.length ? `\n  ... and ${errors.length - visible.length} more` : "";
    throw new Error(`Invalid generated model data:\n${visible.map((error) => `  - ${error}`).join("\n")}${suffix}`);
  }
}

export function validateGeneratedModelData(packageRoot) {
  const structure = readModelDataStructure(packageRoot);
  validateModelDataDirectory(structure, join(packageRoot, "src", "providers", "data"));
}
