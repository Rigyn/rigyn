import { lazyApi } from "./lazy.js";
export function googleGenerativeAIApi() { return lazyApi(async () => import("./google-generative-ai.js")); }
const api = googleGenerativeAIApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
