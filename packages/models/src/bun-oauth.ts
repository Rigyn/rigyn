import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.js";
import { anthropicOAuth } from "./auth/oauth/anthropic.js";
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.js";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.js";
import { xaiOAuth } from "./auth/oauth/xai.js";
export function registerBunOAuthFlows(): void { registerBundledOAuthFlowLoaders({ anthropic: () => anthropicOAuth, githubCopilot: () => githubCopilotOAuth, openaiCodex: () => openaiCodexOAuth, xai: () => xaiOAuth }); }
