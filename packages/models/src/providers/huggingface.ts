import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function huggingfaceProvider(): Provider { return createBuiltinProvider("huggingface"); }
