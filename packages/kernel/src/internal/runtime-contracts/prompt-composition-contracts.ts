export type PromptCompositionSourceKind =
  | "instruction"
  | "system_prompt"
  | "append_system_prompt"
  | "additional_instructions";

/** Content-free provenance for one source included in a composed system prompt. */
export interface PromptCompositionSource {
  kind: PromptCompositionSourceKind;
  source: string;
  bytes: number;
  sha256: string;
  truncated?: boolean;
}

/** Bounded, content-free metadata for the system-prompt composition at the observation point. */
export interface PromptCompositionMetadata {
  bytes: number;
  sha256: string;
  sources: PromptCompositionSource[];
  tools: string[];
  skills: Array<{ name: string; manifestPath: string }>;
  truncated: boolean;
}
