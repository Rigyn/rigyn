import type { OAuthAuth } from "../types.js";
export interface OAuthFlowLoaders { anthropic?: () => OAuthAuth | Promise<OAuthAuth>; openaiCodex?: () => OAuthAuth | Promise<OAuthAuth>; githubCopilot?: () => OAuthAuth | Promise<OAuthAuth>; xai?: () => OAuthAuth | Promise<OAuthAuth>; }
let bundled: OAuthFlowLoaders = {};
export function registerBundledOAuthFlowLoaders(loaders: OAuthFlowLoaders): void { bundled = { ...bundled, ...loaders }; }
export async function loadAnthropicOAuth(): Promise<OAuthAuth> { return bundled.anthropic ? bundled.anthropic() : (await import("./anthropic.js")).anthropicOAuth; }
export async function loadOpenAICodexOAuth(): Promise<OAuthAuth> { return bundled.openaiCodex ? bundled.openaiCodex() : (await import("./openai-codex.js")).openaiCodexOAuth; }
export async function loadGitHubCopilotOAuth(): Promise<OAuthAuth> { return bundled.githubCopilot ? bundled.githubCopilot() : (await import("./github-copilot.js")).githubCopilotOAuth; }
export async function loadXaiOAuth(): Promise<OAuthAuth> { return bundled.xai ? bundled.xai() : (await import("./xai.js")).xaiOAuth; }
