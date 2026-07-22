import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function xiaomiTokenPlanAmsProvider(): Provider { return createBuiltinProvider("xiaomi-token-plan-ams"); }
