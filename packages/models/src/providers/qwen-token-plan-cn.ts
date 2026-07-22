import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function qwenTokenPlanCnProvider(): Provider { return createBuiltinProvider("qwen-token-plan-cn"); }
