import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function cloudflareWorkersAIProvider(): Provider { return createBuiltinProvider("cloudflare-workers-ai"); }
