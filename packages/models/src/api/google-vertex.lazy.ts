import { lazyApi } from "./lazy.js";
export function googleVertexApi() { return lazyApi(async () => import("./google-vertex.js")); }
const api = googleVertexApi(); export const stream = api.stream; export const streamSimple = api.streamSimple;
