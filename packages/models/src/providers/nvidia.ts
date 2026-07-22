import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function nvidiaProvider(): Provider { return createBuiltinProvider("nvidia"); }
