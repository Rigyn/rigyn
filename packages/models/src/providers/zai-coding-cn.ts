import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function zaiCodingCnProvider(): Provider { return createBuiltinProvider("zai-coding-cn"); }
