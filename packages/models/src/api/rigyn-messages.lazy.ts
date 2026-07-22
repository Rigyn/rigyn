import { lazyApi } from "./lazy.js";
export function rigynMessagesApi() { return lazyApi(async () => import("./rigyn-messages.js")); }
const api = rigynMessagesApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
