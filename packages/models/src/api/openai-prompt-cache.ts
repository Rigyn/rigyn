export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const characters = Array.from(key);
  return characters.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH ? key : characters.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
