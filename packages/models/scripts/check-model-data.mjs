import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
const directory = new URL("../src/providers/data/", import.meta.url);
const files = (await readdir(directory)).filter((name) => name.endsWith(".json") && !name.startsWith("."));
if (files.length === 0) throw new Error("No provider model data files found");

const keys = new Set();
for (const file of files) {
  const bytes = await readFile(new URL(file, directory));
  const value = JSON.parse(bytes.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${file} must contain an object`);
  for (const [key, model] of Object.entries(value)) {
    if (typeof model !== "object" || model === null || Array.isArray(model)) throw new Error(`${file}:${key} must contain a model object`);
    if (model.id !== key) throw new Error(`${file}:${key} id must match its key`);
    const identity = `${model.provider}/${model.id}`;
    if (keys.has(identity)) throw new Error(`Duplicate model identity ${identity}`);
    keys.add(identity);
    for (const field of ["api", "provider", "baseUrl", "name"]) if (typeof model[field] !== "string" || model[field] === "") throw new Error(`${identity} has invalid ${field}`);
    for (const field of ["contextWindow", "maxTokens"]) if (!Number.isSafeInteger(model[field]) || model[field] <= 0) throw new Error(`${identity} has invalid ${field}`);
    if (model.maxInputTokens !== undefined && (!Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens <= 0)) throw new Error(`${identity} has invalid maxInputTokens`);
    if (!Array.isArray(model.input) || !model.input.every((item) => item === "text" || item === "image")) throw new Error(`${identity} has invalid input modalities`);
  }
  createHash("sha256").update(bytes).digest("hex");
}

console.log(`Validated ${files.length} provider data files and ${keys.size} models`);
