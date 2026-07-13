import { existsSync, readFileSync } from "node:fs";
import { HarnessError } from "../core/errors.js";
import type { JsonObject } from "./jsonc.js";
import { parseJsoncObject } from "./jsonc.js";
import { mergeConfigLayers } from "./merge.js";

export interface ConfigResolutionInput {
  globalPath?: string;
  projectPath?: string;
  cli?: JsonObject;
  projectTrusted: boolean;
}

export interface ResolvedConfig {
  value: JsonObject;
  appliedSources: Array<"global" | "project" | "cli">;
  projectIgnored: boolean;
}

export function readJsoncConfig(path: string, required = false): JsonObject | undefined {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (cause) {
    if (!required && cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }
    throw new HarnessError("CONFIG_READ", `Unable to read configuration ${path}`, { cause });
  }
  return parseJsoncObject(source, path);
}

export function resolveConfig(input: ConfigResolutionInput): ResolvedConfig {
  const layers: JsonObject[] = [];
  const appliedSources: ResolvedConfig["appliedSources"] = [];
  if (input.globalPath !== undefined) {
    const globalConfig = readJsoncConfig(input.globalPath);
    if (globalConfig !== undefined) {
      layers.push(globalConfig);
      appliedSources.push("global");
    }
  }

  const projectExists = input.projectPath !== undefined && existsSync(input.projectPath);
  if (input.projectTrusted && input.projectPath !== undefined) {
    const projectConfig = readJsoncConfig(input.projectPath);
    if (projectConfig !== undefined) {
      layers.push(projectConfig);
      appliedSources.push("project");
    }
  }

  if (input.cli !== undefined) {
    layers.push(input.cli);
    appliedSources.push("cli");
  }

  return {
    value: mergeConfigLayers(layers),
    appliedSources,
    projectIgnored: projectExists && !input.projectTrusted,
  };
}
