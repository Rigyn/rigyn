import { lazyApi } from "./lazy.js";
export function openAIResponsesApi() { return lazyApi(async () => import("./openai-responses.js")); }
const api = openAIResponsesApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
