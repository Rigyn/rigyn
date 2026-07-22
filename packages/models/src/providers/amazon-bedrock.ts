import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function amazonBedrockProvider(): Provider { return createBuiltinProvider("amazon-bedrock"); }
