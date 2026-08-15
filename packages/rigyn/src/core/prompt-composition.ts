import { sha256 } from "../tools/hash.js";
import type { Skill } from "./skills.js";
import type {
  PromptCompositionMetadata,
  PromptCompositionSource,
  PromptCompositionSourceKind,
} from "./types.js";

interface BuildPromptCompositionMetadataOptions {
  prompt: string;
  sources?: readonly PromptCompositionSource[];
  selectedTools?: readonly string[];
  skills?: readonly Skill[];
}

const MAX_PROMPT_COMPOSITION_METADATA_BYTES = 64 * 1024;
const MAX_PROMPT_COMPOSITION_CANDIDATES = 1_024;

export function promptCompositionSource(
  kind: PromptCompositionSourceKind,
  source: string,
  content: string,
): PromptCompositionSource {
  return {
    kind,
    source,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
  };
}

export function buildPromptCompositionMetadata(
  options: BuildPromptCompositionMetadataOptions,
): PromptCompositionMetadata {
  const metadata: PromptCompositionMetadata = {
    bytes: Buffer.byteLength(options.prompt, "utf8"),
    sha256: sha256(options.prompt),
    sources: [],
    tools: [],
    skills: [],
    truncated: false,
  };
  let candidates = 0;
  const append = <T>(values: T[], value: T): void => {
    candidates += 1;
    if (candidates > MAX_PROMPT_COMPOSITION_CANDIDATES) {
      metadata.truncated = true;
      return;
    }
    values.push(value);
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") <= MAX_PROMPT_COMPOSITION_METADATA_BYTES) return;
    values.pop();
    metadata.truncated = true;
  };
  for (const source of options.sources ?? []) {
    append(metadata.sources, { ...source });
    if (source.truncated === true) metadata.truncated = true;
  }
  const selectedTools = new Set<string>();
  for (const tool of options.selectedTools ?? []) {
    if (selectedTools.has(tool)) continue;
    selectedTools.add(tool);
    append(metadata.tools, tool);
  }
  if (selectedTools.has("read")) {
    for (const skill of options.skills ?? []) {
      if (skill.disableModelInvocation) continue;
      append(metadata.skills, { name: skill.name, manifestPath: skill.filePath });
    }
  }
  return metadata;
}
