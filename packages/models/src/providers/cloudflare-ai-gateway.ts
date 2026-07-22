import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function cloudflareAIGatewayProvider(): Provider { return createBuiltinProvider("cloudflare-ai-gateway"); }
