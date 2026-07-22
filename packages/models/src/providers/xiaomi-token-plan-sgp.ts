import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function xiaomiTokenPlanSgpProvider(): Provider { return createBuiltinProvider("xiaomi-token-plan-sgp"); }
