import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function googleProvider(): Provider { return createBuiltinProvider("google"); }
