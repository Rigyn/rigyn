import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const canonicalTemporaryDirectory = realpathSync(process.env.RUNNER_TEMP ?? tmpdir());
process.env.TMPDIR = canonicalTemporaryDirectory;
process.env.TMP = canonicalTemporaryDirectory;
process.env.TEMP = canonicalTemporaryDirectory;
const isolatedRoot = mkdtempSync(join(canonicalTemporaryDirectory, "rigyn-test-home-"));
const isolatedHome = join(isolatedRoot, "home");
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = join(isolatedRoot, "config");
process.env.XDG_STATE_HOME = join(isolatedRoot, "state");
process.env.XDG_CACHE_HOME = join(isolatedRoot, "cache");
process.env.XDG_DATA_HOME = join(isolatedRoot, "data");
process.env.RIGYN_CODING_AGENT_DIR = join(isolatedHome, ".rigyn", "agent");
process.env.RIGYN_TEST_ISOLATED_ROOT = isolatedRoot;
process.once("exit", () => rmSync(isolatedRoot, {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
}));
