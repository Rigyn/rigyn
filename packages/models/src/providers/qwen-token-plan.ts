import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function qwenTokenPlanProvider(): Provider { return createBuiltinProvider("qwen-token-plan"); }
