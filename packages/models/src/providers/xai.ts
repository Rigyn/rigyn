import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function xaiProvider(): Provider { return createBuiltinProvider("xai"); }
