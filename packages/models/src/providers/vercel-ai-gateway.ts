import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function vercelAIGatewayProvider(): Provider { return createBuiltinProvider("vercel-ai-gateway"); }
