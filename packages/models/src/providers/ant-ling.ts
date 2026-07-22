import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function antLingProvider(): Provider { return createBuiltinProvider("ant-ling"); }
