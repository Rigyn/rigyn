import { lazyApi } from "./lazy.js";
export function openAICodexResponsesApi() { return lazyApi(async () => import("./openai-codex-responses.js")); }
const api = openAICodexResponsesApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
