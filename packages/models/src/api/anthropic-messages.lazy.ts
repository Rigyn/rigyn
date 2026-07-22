import { lazyApi } from "./lazy.js";
export function anthropicMessagesApi() { return lazyApi(async () => import("./anthropic-messages.js")); }
const api = anthropicMessagesApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
