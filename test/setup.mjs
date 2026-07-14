import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

const canonicalTemporaryDirectory = realpathSync(tmpdir());
process.env.TMPDIR = canonicalTemporaryDirectory;
process.env.TMP = canonicalTemporaryDirectory;
process.env.TEMP = canonicalTemporaryDirectory;
