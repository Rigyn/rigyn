#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGeneratedModelData } from "./model-data.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
validateGeneratedModelData(packageRoot);
process.stdout.write("Verified generated provider model data.\n");
