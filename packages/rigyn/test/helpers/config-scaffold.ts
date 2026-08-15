export const CONFIG_SCHEMA_URI = "https://raw.githubusercontent.com/rigyn/rigyn/v0.1.0/packages/rigyn/resources/schemas/config-v1.json";

export const PORTABLE_CONFIG_SCAFFOLD = {
  $schema: CONFIG_SCHEMA_URI,
  transport: "auto",
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  theme: "signal",
  compaction: {
    enabled: true,
    triggerPercent: 85,
  },
  branchSummary: {
    reserveTokens: 18_000,
    skipPrompt: false,
  },
  retry: {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2_000,
    provider: {
      maxRetries: 0,
      maxRetryDelayMs: 60_000,
    },
  },
  observability: { level: "debug" },
  showCacheMissNotices: false,
  quietStartup: false,
  defaultProjectTrust: "ask",
  collapseChangelog: false,
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
  enableSkillCommands: true,
  tools: { excluded: [] },
  terminal: {
    showImages: true,
    imageWidthCells: 60,
    showTerminalProgress: false,
  },
  images: {
    autoResize: true,
    blockImages: false,
  },
  doubleEscapeAction: "tree",
  treeFilterMode: "default",
  editorPaddingX: 0,
  outputPad: 1,
  autocompleteMaxVisible: 5,
  markdown: { codeBlockIndent: "  " },
  warnings: { anthropicExtraUsage: true },
  httpIdleTimeoutMs: 300_000,
  websocketConnectTimeoutMs: 30_000,
  keybindings: {},
} as const;

export function hasNullValue(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(hasNullValue);
  if (typeof value === "object") return Object.values(value).some(hasNullValue);
  return false;
}
