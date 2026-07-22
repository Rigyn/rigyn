import { lazyApi } from "./lazy.js";
export function azureOpenAIResponsesApi() { return lazyApi(async () => import("./azure-openai-responses.js")); }
const api = azureOpenAIResponsesApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
