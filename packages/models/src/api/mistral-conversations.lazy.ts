import { lazyApi } from "./lazy.js";
export function mistralConversationsApi() { return lazyApi(async () => import("./mistral-conversations.js")); }
const api = mistralConversationsApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
