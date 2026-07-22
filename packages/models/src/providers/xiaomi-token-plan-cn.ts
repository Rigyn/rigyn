import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function xiaomiTokenPlanCnProvider(): Provider { return createBuiltinProvider("xiaomi-token-plan-cn"); }
