import { lazyApi } from "./lazy.js";
export function bedrockConverseStreamApi() { return lazyApi(async () => import("./bedrock-converse-stream.js")); }
const api = bedrockConverseStreamApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
