import type { Provider } from "../models.js";
import { createBuiltinProvider } from "./factory.js";

export function moonshotaiCnProvider(): Provider { return createBuiltinProvider("moonshotai-cn"); }
