import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function xiaomiProvider(): Provider { return createBuiltinProvider("xiaomi"); }
