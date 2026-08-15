import { cp, mkdir } from "node:fs/promises";

const source = new URL("../src/providers/data/", import.meta.url);
const target = new URL("../dist/providers/data/", import.meta.url);
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });
