import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const canonicalTemporaryDirectory = realpathSync(process.env.RUNNER_TEMP ?? tmpdir());
process.env.TMPDIR = canonicalTemporaryDirectory;
process.env.TMP = canonicalTemporaryDirectory;
process.env.TEMP = canonicalTemporaryDirectory;
const isolatedStateDirectory = mkdtempSync(join(canonicalTemporaryDirectory, "rigyn-test-state-"));
process.env.XDG_STATE_HOME = isolatedStateDirectory;
process.once("exit", () => rmSync(isolatedStateDirectory, { recursive: true, force: true }));
