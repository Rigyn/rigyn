export function promptCacheKey(sessionId: string, modelId: string): string {
  return `${modelId}:${sessionId}`;
}
