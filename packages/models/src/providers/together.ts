import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function togetherProvider(): Provider { return createBuiltinProvider("together"); }
