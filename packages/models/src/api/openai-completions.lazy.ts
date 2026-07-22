import { lazyApi } from "./lazy.js";
export function openAICompletionsApi() { return lazyApi(async () => import("./openai-completions.js")); }
const api = openAICompletionsApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
