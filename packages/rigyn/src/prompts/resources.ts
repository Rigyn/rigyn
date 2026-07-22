import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledAuthoringResources {
  packageRoot: string;
  documentationRoot: string;
  examplesRoot: string;
  skillRoot: string;
  promptRoot: string;
  authoringSkill: string;
  authoringPrompt: string;
}

export function bundledAuthoringResources(): BundledAuthoringResources {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const skillRoot = join(packageRoot, "resources", "skills");
  const promptRoot = join(packageRoot, "resources", "prompts");
  return {
    packageRoot,
    documentationRoot: join(packageRoot, "docs"),
    examplesRoot: join(packageRoot, "examples"),
    skillRoot,
    promptRoot,
    authoringSkill: join(skillRoot, "build-extension", "SKILL.md"),
    authoringPrompt: join(promptRoot, "build-extension.md"),
  };
}
