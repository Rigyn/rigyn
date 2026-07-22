#!/usr/bin/env node

import { cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "src", "providers", "data");
const destination = join(packageRoot, "dist", "providers", "data");
rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
