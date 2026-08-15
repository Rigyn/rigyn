import type { ConfiguredModel } from "./registry.js";

// Reviewed fallback metadata for the built-in model sources. Live discovery remains authoritative.
const MAINTAINED_MODEL_CATALOG_BASE: readonly ConfiguredModel[] = Object.freeze([
  {
    "provider": "openai",
    "id": "gpt-5.6",
    "metadataSource": "maintained",
    "contextTokens": 1050000,
    "maxOutputTokens": 128000,
    "tools": false,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "requestCompatibility": {
      "supportsExplicitPromptCacheMode": true,
      "supportsPromptCacheBreakpoints": true
    },
    "pricing": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "cacheWrite": 6.25,
      "tiers": [
        {
          "name": "over-272k-input",
          "minimumInputTokens": 272001,
          "input": 10,
          "output": 45,
          "cacheRead": 1,
          "cacheWrite": 12.5
        }
      ]
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.6-sol",
    "metadataSource": "maintained",
    "contextTokens": 1050000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "requestCompatibility": {
      "supportsExplicitPromptCacheMode": true,
      "supportsPromptCacheBreakpoints": true
    },
    "pricing": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "cacheWrite": 6.25,
      "tiers": [
        {
          "name": "over-272k-input",
          "minimumInputTokens": 272001,
          "input": 10,
          "output": 45,
          "cacheRead": 1,
          "cacheWrite": 12.5
        }
      ]
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.6-terra",
    "metadataSource": "maintained",
    "contextTokens": 1050000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "requestCompatibility": {
      "supportsExplicitPromptCacheMode": true,
      "supportsPromptCacheBreakpoints": true
    },
    "pricing": {
      "input": 2,
      "output": 12,
      "cacheRead": 0.2,
      "cacheWrite": 2.5,
      "tiers": [
        {
          "name": "over-272k-input",
          "minimumInputTokens": 272001,
          "input": 4,
          "output": 18,
          "cacheRead": 0.4,
          "cacheWrite": 5
        }
      ]
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.6-luna",
    "metadataSource": "maintained",
    "contextTokens": 1050000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "requestCompatibility": {
      "supportsExplicitPromptCacheMode": true,
      "supportsPromptCacheBreakpoints": true
    },
    "pricing": {
      "input": 0.2,
      "output": 1.2,
      "cacheRead": 0.02,
      "cacheWrite": 0.25,
      "tiers": [
        {
          "name": "over-272k-input",
          "minimumInputTokens": 272001,
          "input": 0.4,
          "output": 1.8,
          "cacheRead": 0.04,
          "cacheWrite": 0.5
        }
      ]
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.4",
    "metadataSource": "maintained",
    "contextTokens": 1050000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "pricing": {
      "input": 2.5,
      "output": 15,
      "cacheRead": 0.25,
      "cacheWrite": 0,
      "tiers": [
        {
          "name": "over-272k-input",
          "minimumInputTokens": 272001,
          "input": 5,
          "output": 22.5,
          "cacheRead": 0.5,
          "cacheWrite": 0
        }
      ]
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.4-mini",
    "metadataSource": "maintained",
    "contextTokens": 400000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "pricing": {
      "input": 0.75,
      "output": 4.5,
      "cacheRead": 0.075,
      "cacheWrite": 0
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.4-nano",
    "metadataSource": "maintained",
    "contextTokens": 400000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "pricing": {
      "input": 0.2,
      "output": 1.25,
      "cacheRead": 0.02,
      "cacheWrite": 0
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5",
    "metadataSource": "maintained",
    "pricing": {
      "input": 1.25,
      "output": 10,
      "cacheRead": 0.125
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.1",
    "metadataSource": "maintained",
    "pricing": {
      "input": 1.25,
      "output": 10,
      "cacheRead": 0.125
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5-mini",
    "metadataSource": "maintained",
    "pricing": {
      "input": 0.25,
      "output": 2,
      "cacheRead": 0.025
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5-nano",
    "metadataSource": "maintained",
    "pricing": {
      "input": 0.05,
      "output": 0.4,
      "cacheRead": 0.005
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5-pro",
    "metadataSource": "maintained",
    "pricing": {
      "input": 15,
      "output": 120
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.2",
    "metadataSource": "maintained",
    "pricing": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.3-codex",
    "metadataSource": "maintained",
    "pricing": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.2-pro",
    "metadataSource": "maintained",
    "pricing": {
      "input": 21,
      "output": 168
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.4-pro",
    "metadataSource": "maintained",
    "pricing": {
      "input": 30,
      "output": 180,
      "tiers": [
        {
          "name": "over-272k-input",
          "minimumInputTokens": 272001,
          "input": 60,
          "output": 270
        }
      ]
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.5-pro",
    "metadataSource": "maintained",
    "pricing": {
      "input": 30,
      "output": 180,
      "tiers": [
        {
          "name": "over-272k-input",
          "minimumInputTokens": 272001,
          "input": 60,
          "output": 270
        }
      ]
    }
  },
  {
    "provider": "openai",
    "id": "gpt-5.5",
    "metadataSource": "maintained",
    "pricing": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "tiers": [
        {
          "name": "over-272k-input",
          "minimumInputTokens": 272001,
          "input": 10,
          "output": 45,
          "cacheRead": 1
        }
      ]
    }
  },
  {
    "provider": "openai",
    "id": "o3",
    "metadataSource": "maintained",
    "pricing": {
      "input": 2,
      "output": 8,
      "cacheRead": 0.5
    }
  },
  {
    "provider": "openai",
    "id": "o3-pro",
    "metadataSource": "maintained",
    "pricing": {
      "input": 20,
      "output": 80
    }
  },
  {
    "provider": "openai",
    "id": "gpt-4.1",
    "metadataSource": "maintained",
    "pricing": {
      "input": 2,
      "output": 8,
      "cacheRead": 0.5
    }
  },
  {
    "provider": "openai",
    "id": "gpt-4.1-mini",
    "metadataSource": "maintained",
    "pricing": {
      "input": 0.4,
      "output": 1.6,
      "cacheRead": 0.1
    }
  },
  {
    "provider": "openai",
    "id": "gpt-4o-mini",
    "metadataSource": "maintained",
    "pricing": {
      "input": 0.15,
      "output": 0.6,
      "cacheRead": 0.075
    }
  },
  {
    "provider": "openai",
    "id": "gpt-4o",
    "metadataSource": "maintained",
    "tools": true,
    "reasoning": false,
    "images": true,
    "pricing": {
      "input": 2.5,
      "output": 10,
      "cacheRead": 1.25
    }
  },
  {
    "provider": "anthropic",
    "id": "claude-fable-5",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pricing": {
      "input": 10,
      "output": 50,
      "cacheRead": 1,
      "cacheWrite": 12.5,
      "cacheWrite5m": 12.5,
      "cacheWrite1h": 20
    }
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-5",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "off": "disabled"
    },
    "pricing": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25,
      "cacheWrite5m": 6.25,
      "cacheWrite1h": 10
    }
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-8",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pricing": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25,
      "cacheWrite5m": 6.25,
      "cacheWrite1h": 10
    }
  },
  {
    "provider": "anthropic",
    "id": "claude-sonnet-5",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pricing": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5,
      "cacheWrite5m": 2.5,
      "cacheWrite1h": 4,
      "validUntil": "2026-09-01T00:00:00.000Z"
    }
  },
  {
    "provider": "anthropic",
    "id": "claude-haiku-4-5",
    "metadataSource": "maintained",
    "contextTokens": 200000,
    "maxOutputTokens": 64000,
    "tools": true,
    "reasoning": false,
    "images": true,
    "pricing": {
      "input": 1,
      "output": 5,
      "cacheRead": 0.1,
      "cacheWrite": 1.25,
      "cacheWrite5m": 1.25,
      "cacheWrite1h": 2
    }
  },
  {
    "provider": "anthropic",
    "id": "claude-haiku-4-5-20251001",
    "metadataSource": "maintained",
    "contextTokens": 200000,
    "maxOutputTokens": 64000,
    "tools": true,
    "reasoning": false,
    "images": true,
    "pricing": {
      "input": 1,
      "output": 5,
      "cacheRead": 0.1,
      "cacheWrite": 1.25,
      "cacheWrite5m": 1.25,
      "cacheWrite1h": 2
    }
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-5",
    "metadataSource": "maintained"
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-5-20251101",
    "metadataSource": "maintained"
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-6",
    "metadataSource": "maintained"
  },
  {
    "provider": "anthropic",
    "id": "claude-opus-4-7",
    "metadataSource": "maintained"
  },
  {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5",
    "metadataSource": "maintained"
  },
  {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5-20250929",
    "metadataSource": "maintained"
  },
  {
    "provider": "anthropic",
    "id": "claude-sonnet-4-6",
    "metadataSource": "maintained"
  },
  {
    "provider": "gemini",
    "id": "gemini-3.6-flash",
    "metadataSource": "maintained",
    "contextTokens": 1048576,
    "maxOutputTokens": 65536,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ],
    "pricing": {
      "input": 1.5,
      "output": 7.5,
      "cacheRead": 0.15
    }
  },
  {
    "provider": "gemini",
    "id": "gemini-3.5-flash",
    "metadataSource": "maintained",
    "contextTokens": 1048576,
    "maxOutputTokens": 65536,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ],
    "pricing": {
      "input": 1.5,
      "output": 9,
      "cacheRead": 0.15
    }
  },
  {
    "provider": "gemini",
    "id": "gemini-3.5-flash-lite",
    "metadataSource": "maintained",
    "contextTokens": 1048576,
    "maxOutputTokens": 65536,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ],
    "pricing": {
      "input": 0.3,
      "output": 2.5,
      "cacheRead": 0.03
    }
  },
  {
    "provider": "gemini",
    "id": "gemini-2.5-flash",
    "metadataSource": "maintained"
  },
  {
    "provider": "gemini",
    "id": "gemini-2.5-flash-lite",
    "metadataSource": "maintained"
  },
  {
    "provider": "gemini",
    "id": "gemini-2.5-pro",
    "metadataSource": "maintained"
  },
  {
    "provider": "gemini",
    "id": "gemini-3-flash-preview",
    "metadataSource": "maintained"
  },
  {
    "provider": "gemini",
    "id": "gemini-3.1-flash-lite",
    "metadataSource": "maintained"
  },
  {
    "provider": "gemini",
    "id": "gemini-3.1-pro-preview",
    "metadataSource": "maintained"
  },
  {
    "provider": "gemini",
    "id": "gemini-3.1-pro-preview-customtools",
    "metadataSource": "maintained"
  },
  {
    "provider": "gemini",
    "id": "gemini-flash-latest",
    "metadataSource": "maintained"
  },
  {
    "provider": "gemini",
    "id": "gemini-flash-lite-latest",
    "metadataSource": "maintained"
  },
  {
    "provider": "deepseek",
    "id": "deepseek-v4-flash",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "maxOutputTokens": 384000,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "low": "high",
      "medium": "high",
      "high": "high",
      "xhigh": "max",
      "max": "max"
    },
    "requestCompatibility": {
      "reasoningFormat": "deepseek",
      "supportsReasoningEffort": true,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.14,
      "output": 0.28,
      "cacheRead": 0.0028
    }
  },
  {
    "provider": "deepseek",
    "id": "deepseek-v4-pro",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "maxOutputTokens": 384000,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "low": "high",
      "medium": "high",
      "high": "high",
      "xhigh": "max",
      "max": "max"
    },
    "requestCompatibility": {
      "reasoningFormat": "deepseek",
      "supportsReasoningEffort": true,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.435,
      "output": 0.87,
      "cacheRead": 0.003625
    }
  },
  {
    "provider": "xai",
    "id": "grok-4.20",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false
    },
    "pricing": {
      "input": 1.25,
      "output": 2.5,
      "cacheRead": 0.2,
      "tiers": [
        {
          "name": "at-least-200k-input",
          "minimumInputTokens": 200000,
          "input": 2.5,
          "output": 5,
          "cacheRead": 0.4
        }
      ]
    }
  },
  {
    "provider": "xai",
    "id": "grok-4.20-non-reasoning",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "tools": true,
    "reasoning": false,
    "images": true,
    "pricing": {
      "input": 1.25,
      "output": 2.5,
      "cacheRead": 0.2,
      "tiers": [
        {
          "name": "at-least-200k-input",
          "minimumInputTokens": 200000,
          "input": 2.5,
          "output": 5,
          "cacheRead": 0.4
        }
      ]
    }
  },
  {
    "provider": "xai",
    "id": "grok-4.20-multi-agent",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "tools": false,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "pricing": {
      "input": 1.25,
      "output": 2.5,
      "cacheRead": 0.2,
      "tiers": [
        {
          "name": "at-least-200k-input",
          "minimumInputTokens": 200000,
          "input": 2.5,
          "output": 5,
          "cacheRead": 0.4
        }
      ]
    }
  },
  {
    "provider": "xai",
    "id": "grok-4.3",
    "metadataSource": "maintained",
    "contextTokens": 1000000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "pricing": {
      "input": 1.25,
      "output": 2.5,
      "cacheRead": 0.2,
      "tiers": [
        {
          "name": "at-least-200k-input",
          "minimumInputTokens": 200000,
          "input": 2.5,
          "output": 5,
          "cacheRead": 0.4
        }
      ]
    }
  },
  {
    "provider": "xai",
    "id": "grok-build-0.1",
    "metadataSource": "maintained",
    "contextTokens": 256000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false
    },
    "pricing": {
      "input": 1,
      "output": 2,
      "cacheRead": 0.2,
      "tiers": [
        {
          "name": "at-least-200k-input",
          "minimumInputTokens": 200000,
          "input": 2,
          "output": 4,
          "cacheRead": 0.4
        }
      ]
    }
  },
  {
    "provider": "xai",
    "id": "grok-4.5",
    "metadataSource": "maintained",
    "contextTokens": 500000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ],
    "pricing": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.3,
      "tiers": [
        {
          "name": "at-least-200k-input",
          "minimumInputTokens": 200000,
          "input": 4,
          "output": 12,
          "cacheRead": 0.6
        }
      ]
    }
  },
  {
    "provider": "xai",
    "id": "grok-4.6",
    "metadataSource": "maintained",
    "contextTokens": 500000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ],
    "pricing": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.5,
      "tiers": [
        {
          "name": "at-least-200k-input",
          "minimumInputTokens": 200000,
          "input": 4,
          "output": 12,
          "cacheRead": 1
        }
      ]
    }
  },
  {
    "provider": "openrouter",
    "id": "openrouter/auto",
    "metadataSource": "maintained"
  },
  {
    "provider": "openrouter",
    "id": "moonshotai/kimi-k2.6",
    "metadataSource": "maintained",
    "contextTokens": 262144,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "medium"
    ],
    "requestCompatibility": {
      "supportsCacheControlOnTools": false
    },
    "pricing": {
      "input": 0.95,
      "output": 4,
      "cacheRead": 0.16
    }
  },
  {
    "provider": "openrouter",
    "id": "moonshotai/kimi-k2.7-code",
    "metadataSource": "maintained",
    "contextTokens": 262144,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "reasoningEffortMap": {
      "off": null
    },
    "pricing": {
      "input": 0.67,
      "output": 3.4,
      "cacheRead": 0.15
    }
  },
  {
    "provider": "opencode",
    "id": "claude-fable-5",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "claude-opus-4-7",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "claude-opus-4-8",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "claude-opus-5",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "claude-sonnet-5",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "claude-opus-4-5",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gemini-3.1-pro",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5-codex",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5.1-codex",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5.1-codex-mini",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "grok-4.5",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "grok-4.6",
    "metadataSource": "maintained",
    "displayName": "Grok 4.6",
    "description": "xAI frontier model for long-running agents, coding, knowledge work, and visual projects",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "pricing": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.5,
      "tiers": [
        {
          "name": "over-200k-input",
          "minimumInputTokens": 200001,
          "input": 4,
          "output": 12,
          "cacheRead": 1
        }
      ]
    }
  },
  {
    "provider": "opencode",
    "id": "laguna-s-2.1-free",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "hy3-free",
    "metadataSource": "maintained",
    "displayName": "Hy3 Free",
    "description": "Tencent Hy reasoning model for coding, instruction following, and agent tasks",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "requestCompatibility": {
      "supportsReasoningEffort": true,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0,
      "output": 0,
      "cacheRead": 0
    }
  },
  {
    "provider": "opencode",
    "id": "ling-3.0-tiny-free",
    "metadataSource": "maintained",
    "displayName": "Ling-3.0-tiny Free",
    "description": "Compact MoE model for responsive agents, instruction following, and multi-turn conversations",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false
    },
    "pricing": {
      "input": 0,
      "output": 0,
      "cacheRead": 0
    }
  },
  {
    "provider": "opencode",
    "id": "claude-opus-4-6",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "claude-sonnet-4-6",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "gemini-3-flash",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gemini-3.5-flash",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gemini-3.5-flash-lite",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gemini-3.6-flash",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5-nano",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "minimal",
      "low",
      "medium",
      "high"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5.1",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.1-codex-max",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5.2-codex",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5.2",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.3-codex",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.3-codex-spark",
    "metadataSource": "maintained",
    "displayName": "GPT-5.3 Codex Spark",
    "description": "Coding-optimized GPT model for repository edits, reviews, and agentic software work",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "pricing": {
      "input": 1.75,
      "output": 14,
      "cacheRead": 0.175
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.4",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.4-mini",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.4-nano",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.5",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.4-pro",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "medium",
      "high",
      "xhigh"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5.5-pro",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "medium",
      "high",
      "xhigh"
    ]
  },
  {
    "provider": "opencode",
    "id": "gpt-5.6-luna",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.6-sol",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "gpt-5.6-terra",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "off": "none"
    }
  },
  {
    "provider": "opencode",
    "id": "deepseek-v4-flash",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "high",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "deepseek-v4-flash-free",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "high",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "deepseek-v4-pro",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "high",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "glm-5.2",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "high",
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "kimi-k3",
    "metadataSource": "maintained",
    "reasoning": true,
    "reasoningEfforts": [
      "max"
    ]
  },
  {
    "provider": "opencode",
    "id": "big-pickle",
    "metadataSource": "maintained",
    "displayName": "Big Pickle",
    "description": "Reasoning model for deliberate analysis, multi-step problem solving, and tool use",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    }
  },
  {
    "provider": "opencode",
    "id": "claude-haiku-4-5",
    "metadataSource": "maintained",
    "displayName": "Claude Haiku 4.5",
    "description": "Fast Claude model for responsive assistance, classification, and lightweight agents",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pricing": {
      "input": 1,
      "output": 5,
      "cacheRead": 0.1,
      "cacheWrite": 1.25
    }
  },
  {
    "provider": "opencode",
    "id": "claude-sonnet-4-5",
    "metadataSource": "maintained",
    "displayName": "Claude Sonnet 4.5",
    "description": "Balanced Claude model for coding, analysis, agent workflows, and cost control",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pricing": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheWrite": 3.75,
      "tiers": [
        {
          "name": "over-200k-input",
          "minimumInputTokens": 200001,
          "input": 6,
          "output": 22.5,
          "cacheRead": 0.6,
          "cacheWrite": 7.5
        }
      ]
    }
  },
  {
    "provider": "opencode",
    "id": "glm-5",
    "metadataSource": "maintained",
    "displayName": "GLM-5",
    "description": "Flagship GLM model for hybrid reasoning, coding, and agentic engineering",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "off",
      "medium"
    ],
    "requestCompatibility": {
      "reasoningFormat": "zai",
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 1,
      "output": 3.2,
      "cacheRead": 0.2
    }
  },
  {
    "provider": "opencode",
    "id": "glm-5.1",
    "metadataSource": "maintained",
    "displayName": "GLM-5.1",
    "description": "Flagship GLM model for hybrid reasoning, coding, and agentic engineering",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "off",
      "medium"
    ],
    "requestCompatibility": {
      "reasoningFormat": "zai",
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 1.4,
      "output": 4.4,
      "cacheRead": 0.26
    }
  },
  {
    "provider": "opencode",
    "id": "grok-build-0.1",
    "metadataSource": "maintained",
    "displayName": "Grok Build 0.1",
    "description": "Fast Grok coding model tuned for agentic engineering and iterative edits",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false
    },
    "pricing": {
      "input": 1,
      "output": 2,
      "cacheRead": 0.2
    }
  },
  {
    "provider": "opencode",
    "id": "kimi-k2.5",
    "metadataSource": "maintained",
    "displayName": "Kimi K2.5",
    "description": "Kimi multimodal agent model for visual understanding, coding, and planning",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.6,
      "output": 3,
      "cacheRead": 0.1
    }
  },
  {
    "provider": "opencode",
    "id": "kimi-k2.6",
    "metadataSource": "maintained",
    "displayName": "Kimi K2.6",
    "description": "Kimi multimodal agent model for visual understanding, coding, and planning",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.95,
      "output": 4,
      "cacheRead": 0.16
    }
  },
  {
    "provider": "opencode",
    "id": "kimi-k2.7-code",
    "metadataSource": "maintained",
    "displayName": "Kimi K2.7 Code",
    "description": "Coding-focused Kimi model, stronger on long-horizon repo work with less overthinking",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.95,
      "output": 4,
      "cacheRead": 0.19
    }
  },
  {
    "provider": "opencode",
    "id": "mimo-v2.5-free",
    "metadataSource": "maintained",
    "displayName": "MiMo V2.5 Free",
    "description": "MiMo omni model for text, image, video, audio, and agents",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0,
      "output": 0,
      "cacheRead": 0
    }
  },
  {
    "provider": "opencode",
    "id": "minimax-m2.5",
    "metadataSource": "maintained",
    "displayName": "MiniMax-M2.5",
    "description": "MiniMax model for chat, coding, office work, and agentic tasks",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.06
    }
  },
  {
    "provider": "opencode",
    "id": "minimax-m2.7",
    "metadataSource": "maintained",
    "displayName": "MiniMax-M2.7",
    "description": "MiniMax model for chat, coding, office work, and agentic tasks",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.06
    }
  },
  {
    "provider": "opencode",
    "id": "minimax-m3",
    "metadataSource": "maintained",
    "displayName": "MiniMax-M3",
    "description": "MiniMax multimodal model for long-context coding, perception, and agent planning",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.06
    }
  },
  {
    "provider": "opencode",
    "id": "nemotron-3.5-lightning-free",
    "metadataSource": "maintained",
    "displayName": "Nemotron 3.5 Lightning Free",
    "description": "Fast NVIDIA Nemotron MoE for reliable agentic tasks across enterprise workloads",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0,
      "output": 0,
      "cacheRead": 0
    }
  },
  {
    "provider": "opencode",
    "id": "nemotron-3-ultra-free",
    "metadataSource": "maintained",
    "displayName": "Nemotron 3 Ultra Free",
    "description": "Largest Nemotron 3 model for maximum open-weight reasoning and agent accuracy",
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0,
      "output": 0,
      "cacheRead": 0
    }
  },
  {
    "provider": "opencode",
    "id": "qwen3.5-plus",
    "metadataSource": "maintained",
    "displayName": "Qwen3.5 Plus",
    "description": "Multimodal reasoning model for visual analysis, planning, and tool use",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pricing": {
      "input": 0.2,
      "output": 1.2,
      "cacheRead": 0.02,
      "cacheWrite": 0.25
    }
  },
  {
    "provider": "opencode",
    "id": "qwen3.6-plus",
    "metadataSource": "maintained",
    "displayName": "Qwen3.6 Plus",
    "description": "Multimodal reasoning model for visual analysis, planning, and tool use",
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "pricing": {
      "input": 0.5,
      "output": 3,
      "cacheRead": 0.05,
      "cacheWrite": 0.625
    }
  },
  {
    "provider": "opencode",
    "id": "qwen3.7-max",
    "metadataSource": "maintained"
  },
  {
    "provider": "opencode",
    "id": "qwen3.7-plus",
    "metadataSource": "maintained"
  },
  {
    "provider": "opencode-go",
    "id": "deepseek-v4-flash",
    "metadataSource": "maintained",
    "displayName": "DeepSeek V4 Flash (2x usage)",
    "description": "Official DeepSeek V4 Flash release with enhanced agentic capabilities",
    "contextTokens": 1000000,
    "maxOutputTokens": 384000,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "low",
      "high",
      "max"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": true,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.14,
      "output": 0.28,
      "cacheRead": 0.0028
    }
  },
  {
    "provider": "opencode-go",
    "id": "deepseek-v4-pro",
    "metadataSource": "maintained",
    "displayName": "DeepSeek V4 Pro",
    "description": "Flagship DeepSeek model for coding, reasoning, and agentic work",
    "contextTokens": 1000000,
    "maxOutputTokens": 384000,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "high",
      "max"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": true,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.435,
      "output": 0.87,
      "cacheRead": 0.003625
    }
  },
  {
    "provider": "opencode-go",
    "id": "glm-5.1",
    "metadataSource": "maintained",
    "displayName": "GLM-5.1",
    "description": "Flagship GLM model for hybrid reasoning, coding, and agentic engineering",
    "contextTokens": 202752,
    "maxOutputTokens": 32768,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 1.4,
      "output": 4.4,
      "cacheRead": 0.26
    }
  },
  {
    "provider": "opencode-go",
    "id": "glm-5.2",
    "metadataSource": "maintained",
    "displayName": "GLM-5.2",
    "description": "Open flagship GLM for long-horizon coding agents and million-token context work",
    "contextTokens": 1000000,
    "maxOutputTokens": 131072,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "high",
      "max"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": true,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 1.4,
      "output": 4.4,
      "cacheRead": 0.26
    }
  },
  {
    "provider": "opencode-go",
    "id": "gpt-5.6-luna",
    "metadataSource": "maintained",
    "displayName": "GPT-5.6 Luna (2x usage)",
    "description": "Cost-efficient GPT-5.6 model for fast, high-volume workloads",
    "contextTokens": 1050000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "pricing": {
      "input": 0.2,
      "output": 1.2,
      "cacheRead": 0.02,
      "cacheWrite": 0.25,
      "tiers": [
        {
          "name": "over-272k-input",
          "minimumInputTokens": 272001,
          "input": 0.4,
          "output": 1.8,
          "cacheRead": 0.04,
          "cacheWrite": 0.5
        }
      ]
    }
  },
  {
    "provider": "opencode-go",
    "id": "grok-4.5",
    "metadataSource": "maintained",
    "displayName": "Grok 4.5",
    "description": "xAI's latest Grok for chat, coding, agentic tools, and lower hallucination risk",
    "contextTokens": 500000,
    "maxOutputTokens": 500000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "low",
      "medium",
      "high"
    ],
    "pricing": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.3
    }
  },
  {
    "provider": "opencode-go",
    "id": "hy3",
    "metadataSource": "maintained",
    "displayName": "Hy3",
    "description": "Tencent Hy reasoning model for coding, instruction following, and agent tasks",
    "contextTokens": 256000,
    "maxOutputTokens": 64000,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "off",
      "low",
      "high"
    ],
    "reasoningEffortMap": {
      "off": "none"
    },
    "requestCompatibility": {
      "supportsReasoningEffort": true
    },
    "pricing": {
      "input": 0.14,
      "output": 0.58,
      "cacheRead": 0.035
    }
  },
  {
    "provider": "opencode-go",
    "id": "kimi-k2.6",
    "metadataSource": "maintained",
    "displayName": "Kimi K2.6",
    "description": "Kimi multimodal agent model for visual understanding, coding, and planning",
    "contextTokens": 262144,
    "maxOutputTokens": 65536,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.95,
      "output": 4,
      "cacheRead": 0.16
    }
  },
  {
    "provider": "opencode-go",
    "id": "kimi-k2.7-code",
    "metadataSource": "maintained",
    "displayName": "Kimi K2.7 Code",
    "description": "Coding-focused Kimi model, stronger on long-horizon repo work with less overthinking",
    "contextTokens": 262144,
    "maxOutputTokens": 262144,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.95,
      "output": 4,
      "cacheRead": 0.19
    }
  },
  {
    "provider": "opencode-go",
    "id": "kimi-k3",
    "metadataSource": "maintained",
    "displayName": "Kimi K3",
    "description": "Multimodal Kimi model with 1M context and toggleable max-effort thinking for long-horizon agent work",
    "contextTokens": 1048576,
    "maxOutputTokens": 131072,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "max"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": true,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3
    }
  },
  {
    "provider": "opencode-go",
    "id": "mimo-v2.5",
    "metadataSource": "maintained",
    "displayName": "MiMo V2.5",
    "description": "MiMo omni model for text, image, video, audio, and agents",
    "contextTokens": 1000000,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.14,
      "output": 0.28,
      "cacheRead": 0.0028
    }
  },
  {
    "provider": "opencode-go",
    "id": "mimo-v2.5-pro",
    "metadataSource": "maintained",
    "displayName": "MiMo V2.5 Pro",
    "description": "MiMo pro model for strong multimodal reasoning and agent execution",
    "contextTokens": 1048576,
    "maxOutputTokens": 128000,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    },
    "pricing": {
      "input": 0.435,
      "output": 0.87,
      "cacheRead": 0.003625
    }
  },
  {
    "provider": "opencode-go",
    "id": "minimax-m2.7",
    "metadataSource": "maintained",
    "displayName": "MiniMax-M2.7",
    "description": "MiniMax model for chat, coding, office work, and agentic tasks",
    "contextTokens": 204800,
    "maxOutputTokens": 131072,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "off"
    ],
    "pricing": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.06,
      "cacheWrite": 0.375
    }
  },
  {
    "provider": "opencode-go",
    "id": "minimax-m3",
    "metadataSource": "maintained",
    "displayName": "MiniMax-M3",
    "description": "MiniMax multimodal coding model for long-context reasoning and agent tasks",
    "contextTokens": 1000000,
    "maxOutputTokens": 131072,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "off",
      "high"
    ],
    "pricing": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.06
    }
  },
  {
    "provider": "opencode-go",
    "id": "qwen3.6-plus",
    "metadataSource": "maintained",
    "displayName": "Qwen3.6 Plus",
    "description": "Multimodal reasoning model for visual analysis, planning, and tool use",
    "contextTokens": 1000000,
    "maxOutputTokens": 65536,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "high",
      "max"
    ],
    "pricing": {
      "input": 0.5,
      "output": 3,
      "cacheRead": 0.05,
      "cacheWrite": 0.625,
      "tiers": [
        {
          "name": "over-256k-input",
          "minimumInputTokens": 256001,
          "input": 2,
          "output": 6,
          "cacheRead": 0.2,
          "cacheWrite": 2.5
        }
      ]
    }
  },
  {
    "provider": "opencode-go",
    "id": "qwen3.7-max",
    "metadataSource": "maintained",
    "displayName": "Qwen3.7 Max",
    "description": "Flagship model for demanding analysis, coding, and production agent workflows",
    "contextTokens": 1000000,
    "maxOutputTokens": 65536,
    "tools": true,
    "reasoning": true,
    "images": false,
    "reasoningEfforts": [
      "high",
      "max"
    ],
    "pricing": {
      "input": 2.5,
      "output": 7.5,
      "cacheRead": 0.5,
      "cacheWrite": 3.125
    }
  },
  {
    "provider": "opencode-go",
    "id": "qwen3.7-plus",
    "metadataSource": "maintained",
    "displayName": "Qwen3.7 Plus",
    "description": "Multimodal reasoning model for visual analysis, planning, and tool use",
    "contextTokens": 1000000,
    "maxOutputTokens": 65536,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "high",
      "max"
    ],
    "pricing": {
      "input": 0.4,
      "output": 1.6,
      "cacheRead": 0.04,
      "cacheWrite": 0.5,
      "tiers": [
        {
          "name": "over-256k-input",
          "minimumInputTokens": 256001,
          "input": 1.2,
          "output": 4.8,
          "cacheRead": 0.12,
          "cacheWrite": 1.5
        }
      ]
    }
  },
  {
    "provider": "opencode-go",
    "id": "qwen3.8-max",
    "metadataSource": "maintained",
    "displayName": "Qwen3.8 Max",
    "description": "2.4-trillion-parameter multimodal flagship for coding, professional work, and long-horizon agentic workflows",
    "contextTokens": 1000000,
    "maxOutputTokens": 131072,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "high",
      "max"
    ],
    "pricing": {
      "input": 2,
      "output": 6,
      "cacheRead": 0.25,
      "cacheWrite": 2.5
    }
  },
  {
    "provider": "kimi-code",
    "id": "k3",
    "metadataSource": "maintained",
    "displayName": "Kimi K3",
    "description": "Kimi Code membership model for long-context coding and agent workflows",
    "contextTokens": 1048576,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "low",
      "high",
      "max"
    ],
    "requestCompatibility": {
      "maxTokensField": "max_completion_tokens",
      "supportsReasoningEffort": true,
      "requiresReasoningContentOnAssistantMessages": true
    }
  },
  {
    "provider": "kimi-code",
    "id": "k3-256k",
    "metadataSource": "maintained",
    "displayName": "Kimi K3 256K",
    "description": "Kimi Code membership model with a fixed 256K context window",
    "contextTokens": 262144,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "low",
      "high",
      "max"
    ],
    "requestCompatibility": {
      "maxTokensField": "max_completion_tokens",
      "supportsReasoningEffort": true,
      "requiresReasoningContentOnAssistantMessages": true
    }
  },
  {
    "provider": "kimi-code",
    "id": "kimi-for-coding",
    "metadataSource": "maintained",
    "displayName": "Kimi for Coding",
    "description": "Kimi Code membership model for coding and agent workflows",
    "contextTokens": 262144,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "maxTokensField": "max_completion_tokens",
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    }
  },
  {
    "provider": "kimi-code",
    "id": "kimi-for-coding-highspeed",
    "metadataSource": "maintained",
    "displayName": "Kimi for Coding Highspeed",
    "description": "Faster Kimi Code membership model for coding and agent workflows",
    "contextTokens": 262144,
    "tools": true,
    "reasoning": true,
    "images": true,
    "reasoningEfforts": [
      "medium"
    ],
    "requestCompatibility": {
      "maxTokensField": "max_completion_tokens",
      "supportsReasoningEffort": false,
      "requiresReasoningContentOnAssistantMessages": true
    }
  }
]);

const PUBLISHED_LIMIT_GROUPS = [
  {
    provider: "anthropic", contextTokens: 200_000, maxOutputTokens: 64_000,
    ids: ["claude-opus-4-5", "claude-opus-4-5-20251101"],
  },
  {
    provider: "anthropic", contextTokens: 1_000_000, maxOutputTokens: 128_000,
    ids: ["claude-opus-4-6", "claude-opus-4-7", "claude-sonnet-4-6"],
  },
  {
    provider: "anthropic", contextTokens: 1_000_000, maxOutputTokens: 64_000,
    ids: ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"],
  },
  {
    provider: "gemini", contextTokens: 1_048_576, maxOutputTokens: 65_536,
    ids: [
      "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview",
      "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
      "gemini-flash-latest", "gemini-flash-lite-latest",
    ],
  },
  {
    provider: "openai", contextTokens: 400_000, maxOutputTokens: 128_000,
    ids: ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5-mini", "gpt-5-nano"],
  },
  { provider: "openai", contextTokens: 400_000, maxOutputTokens: 272_000, ids: ["gpt-5-pro"] },
  {
    provider: "openai", contextTokens: 1_050_000, maxOutputTokens: 128_000,
    ids: ["gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro"],
  },
  { provider: "openai", contextTokens: 200_000, maxOutputTokens: 100_000, ids: ["o3", "o3-pro"] },
  { provider: "openai", contextTokens: 1_047_576, maxOutputTokens: 32_768, ids: ["gpt-4.1", "gpt-4.1-mini"] },
  { provider: "openai", contextTokens: 128_000, maxOutputTokens: 16_384, ids: ["gpt-4o", "gpt-4o-mini"] },
  { provider: "xai", contextTokens: 1_000_000, maxOutputTokens: 30_000, ids: ["grok-4.3"] },
  { provider: "xai", contextTokens: 256_000, maxOutputTokens: 256_000, ids: ["grok-build-0.1"] },
  { provider: "xai", contextTokens: 500_000, maxOutputTokens: 500_000, ids: ["grok-4.5"] },
  {
    provider: "openrouter", contextTokens: 262_144, maxOutputTokens: 262_144,
    ids: ["moonshotai/kimi-k2.6", "moonshotai/kimi-k2.7-code"],
  },
  {
    provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 128_000,
    ids: ["claude-fable-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"],
  },
  { provider: "opencode", contextTokens: 200_000, maxOutputTokens: 64_000, ids: ["claude-haiku-4-5", "claude-opus-4-5"] },
  { provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 64_000, ids: ["claude-sonnet-4-5", "claude-sonnet-4-6"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 65_536, ids: ["qwen3.5-plus", "qwen3.6-plus"] },
  {
    provider: "opencode", contextTokens: 1_048_576, maxOutputTokens: 65_536,
    ids: ["gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
  },
  {
    provider: "opencode", contextTokens: 400_000, maxOutputTokens: 128_000,
    ids: [
      "gpt-5", "gpt-5-codex", "gpt-5-nano", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4-mini", "gpt-5.4-nano",
    ],
  },
  {
    provider: "opencode", contextTokens: 1_050_000, maxOutputTokens: 128_000,
    ids: ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  },
  { provider: "opencode", contextTokens: 128_000, maxOutputTokens: 128_000, ids: ["gpt-5.3-codex-spark"] },
  { provider: "opencode", contextTokens: 500_000, maxOutputTokens: 500_000, ids: ["grok-4.5", "grok-4.6"] },
  { provider: "opencode", contextTokens: 256_000, maxOutputTokens: 256_000, ids: ["grok-build-0.1"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 65_536, ids: ["kimi-k2.5", "kimi-k2.6"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 262_144, ids: ["kimi-k2.7-code"] },
  { provider: "opencode", contextTokens: 200_000, maxOutputTokens: 32_000, ids: ["big-pickle", "mimo-v2.5-free"] },
  { provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 384_000, ids: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { provider: "opencode", contextTokens: 200_000, maxOutputTokens: 128_000, ids: ["deepseek-v4-flash-free"] },
  { provider: "opencode", contextTokens: 204_800, maxOutputTokens: 131_072, ids: ["glm-5", "glm-5.1", "minimax-m2.5", "minimax-m2.7"] },
  { provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 131_072, ids: ["glm-5.2"] },
  { provider: "opencode", contextTokens: 1_048_576, maxOutputTokens: 131_072, ids: ["kimi-k3"] },
  { provider: "opencode", contextTokens: 190_000, maxOutputTokens: 64_000, ids: ["hy3-free"] },
  { provider: "opencode", contextTokens: 256_000, maxOutputTokens: 32_000, ids: ["laguna-s-2.1-free"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 32_768, ids: ["ling-3.0-tiny-free"] },
  { provider: "opencode", contextTokens: 512_000, maxOutputTokens: 128_000, ids: ["minimax-m3"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 262_144, ids: ["nemotron-3.5-lightning-free"] },
  { provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 128_000, ids: ["nemotron-3-ultra-free"] },
] as const;

const PUBLISHED_LIMITS = new Map<string, { contextTokens: number; maxOutputTokens: number }>(
  PUBLISHED_LIMIT_GROUPS.flatMap((group) => group.ids.map((id) => [
    `${group.provider}\0${id}`,
    { contextTokens: group.contextTokens, maxOutputTokens: group.maxOutputTokens },
  ])),
);

const PUBLISHED_MAX_INPUT_GROUPS = [
  {
    provider: "openai", maxInputTokens: 922_000,
    ids: ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  },
  {
    provider: "openai", maxInputTokens: 272_000,
    ids: ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5-mini", "gpt-5-nano", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5-pro"],
  },
  {
    provider: "opencode", maxInputTokens: 272_000,
    ids: [
      "gpt-5", "gpt-5-codex", "gpt-5-nano", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4-mini", "gpt-5.4-nano",
    ],
  },
  {
    provider: "opencode", maxInputTokens: 922_000,
    ids: ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  },
  { provider: "opencode", maxInputTokens: 128_000, ids: ["gpt-5.3-codex-spark"] },
  { provider: "opencode", maxInputTokens: 160_000, ids: ["big-pickle"] },
  { provider: "opencode-go", maxInputTokens: 922_000, ids: ["gpt-5.6-luna"] },
] as const;

const PUBLISHED_MAX_INPUTS = new Map<string, number>(
  PUBLISHED_MAX_INPUT_GROUPS.flatMap((group) => group.ids.map((id) => [
    `${group.provider}\0${id}`,
    group.maxInputTokens,
  ])),
);

export const MAINTAINED_MODEL_CATALOG: readonly ConfiguredModel[] = Object.freeze(
  MAINTAINED_MODEL_CATALOG_BASE.map((model) => {
    const reference = `${model.provider}\0${model.id}`;
    const limits = PUBLISHED_LIMITS.get(reference);
    const maxInputTokens = PUBLISHED_MAX_INPUTS.get(reference);
    return limits === undefined && maxInputTokens === undefined
      ? model
      : { ...model, ...limits, ...(maxInputTokens === undefined ? {} : { maxInputTokens }) };
  }),
);

const MAINTAINED_BY_REFERENCE = new Map(
  MAINTAINED_MODEL_CATALOG.map((model) => [`${model.provider}\0${model.id}`, model]),
);

export function maintainedModelMetadata(provider: string, id: string): ConfiguredModel | undefined {
  return MAINTAINED_BY_REFERENCE.get(`${provider}\0${id}`);
}

export function configuredModelsWithMaintainedCatalog(configured: readonly ConfiguredModel[]): ConfiguredModel[] {
  const overridden = new Set(configured.map((model) => `${model.provider}\0${model.id}`));
  return [
    ...MAINTAINED_MODEL_CATALOG.filter((model) => !overridden.has(`${model.provider}\0${model.id}`)),
    ...configured,
  ];
}
