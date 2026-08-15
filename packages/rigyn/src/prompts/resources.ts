import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BundledAuthoringResources {
  packageRoot: string;
  documentationRoot: string;
  examplesRoot: string;
  skillRoot: string;
  authoringSkill: string;
}

export function bundledAuthoringResources(): BundledAuthoringResources {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const skillRoot = join(packageRoot, "resources", "skills");
  return {
    packageRoot,
    documentationRoot: join(packageRoot, "docs"),
    examplesRoot: join(packageRoot, "examples"),
    skillRoot,
    authoringSkill: join(skillRoot, "rigyn-dev", "SKILL.md"),
  };
}
