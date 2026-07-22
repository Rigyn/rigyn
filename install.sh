#!/bin/sh
set -eu

umask 077

rigyn_fail() {
  printf 'Rigyn install: %s\n' "$*" >&2
  exit 1
}

for rigyn_command in curl node npm mktemp; do
  command -v "$rigyn_command" >/dev/null 2>&1 || rigyn_fail "$rigyn_command is required"
done
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (!((major === 24 && minor >= 15) || major >= 26)) process.exit(1);
' || rigyn_fail "Node.js 24.15+ or 26+ is required"

rigyn_release_root=https://github.com/Rigyn/rigyn/releases
if ! rigyn_latest_url=$(curl \
  --proto '=https' \
  --proto-redir '=https' \
  --location \
  --fail \
  --silent \
  --show-error \
  --connect-timeout 15 \
  --max-time 300 \
  --max-filesize 1048576 \
  --retry 2 \
  --output /dev/null \
  --write-out '%{url_effective}' \
  "$rigyn_release_root/latest"
); then
  rigyn_fail "could not resolve the latest GitHub release"
fi
rigyn_latest_url=${rigyn_latest_url%/}
case "$rigyn_latest_url" in
  "$rigyn_release_root/tag/"*) rigyn_tag=${rigyn_latest_url##*/} ;;
  *) rigyn_fail "GitHub returned an unexpected latest-release URL" ;;
esac
rigyn_version=${rigyn_tag#v}
node -e '
const version = process.argv[1];
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
if (`v${version}` !== process.argv[2] || !semanticVersion.test(version)) process.exit(1);
' "$rigyn_version" "$rigyn_tag" || rigyn_fail "GitHub returned an invalid release tag"

rigyn_tmp_base=${TMPDIR:-/tmp}
[ -d "$rigyn_tmp_base" ] || rigyn_fail "temporary directory does not exist: $rigyn_tmp_base"
rigyn_tmp=$(mktemp -d "$rigyn_tmp_base/rigyn-install.XXXXXX") || rigyn_fail "could not create a private temporary directory"
rigyn_cleanup() {
  if [ -n "${rigyn_tmp:-}" ] && [ -d "$rigyn_tmp" ]; then
    rm -rf -- "$rigyn_tmp"
  fi
}
trap rigyn_cleanup 0 HUP INT TERM

rigyn_download() {
  rigyn_url=$1
  rigyn_destination=$2
  rigyn_limit=$3
  curl \
    --proto '=https' \
    --proto-redir '=https' \
    --location \
    --fail \
    --silent \
    --show-error \
    --connect-timeout 15 \
    --max-time 300 \
    --max-filesize "$rigyn_limit" \
    --retry 2 \
    --output "$rigyn_destination" \
    "$rigyn_url"
}

rigyn_asset_root="$rigyn_release_root/download/$rigyn_tag"
rigyn_checksums="$rigyn_tmp/SHA256SUMS"
rigyn_download "$rigyn_asset_root/SHA256SUMS" "$rigyn_checksums" 1048576 \
  || rigyn_fail "could not download SHA256SUMS"

set -- \
  "rigyn-terminal-$rigyn_version.tgz" \
  "rigyn-models-$rigyn_version.tgz" \
  "rigyn-kernel-$rigyn_version.tgz" \
  "rigyn-$rigyn_version.tgz"
for rigyn_file do
  rigyn_download "$rigyn_asset_root/$rigyn_file" "$rigyn_tmp/$rigyn_file" 268435456 \
    || rigyn_fail "could not download $rigyn_file"
done

node -e '
const { createHash } = require("node:crypto");
const { createReadStream, readFileSync } = require("node:fs");
const { basename } = require("node:path");

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

(async () => {
  const [checksumPath, ...archives] = process.argv.slice(1);
  const wanted = new Set(archives.map((path) => basename(path)));
  const expected = new Map();
  const lines = readFileSync(checksumPath, "utf8").replace(/\r\n?/gu, "\n").split("\n");
  for (const line of lines) {
    if (line === "") continue;
    const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/u.exec(line);
    if (match === null) throw new Error("SHA256SUMS contains an invalid line");
    if (!wanted.has(match[2])) continue;
    if (expected.has(match[2])) throw new Error(`SHA256SUMS repeats ${match[2]}`);
    expected.set(match[2], match[1]);
  }
  for (const archive of archives) {
    const name = basename(archive);
    if (!expected.has(name)) throw new Error(`SHA256SUMS does not list ${name}`);
    if (await sha256(archive) !== expected.get(name)) throw new Error(`checksum mismatch for ${name}`);
  }
})().catch((error) => {
  process.stderr.write(`Rigyn install: ${error.message}\n`);
  process.exitCode = 1;
});
' "$rigyn_checksums" \
  "$rigyn_tmp/$1" \
  "$rigyn_tmp/$2" \
  "$rigyn_tmp/$3" \
  "$rigyn_tmp/$4"

: > "$rigyn_tmp/user.npmrc"
: > "$rigyn_tmp/global.npmrc"
npm_config_audit=false \
npm_config_cache="$rigyn_tmp/npm-cache" \
npm_config_fund=false \
npm_config_global=false \
npm_config_globalconfig="$rigyn_tmp/global.npmrc" \
npm_config_update_notifier=false \
npm_config_userconfig="$rigyn_tmp/user.npmrc" \
npm exec --yes \
  --package="$rigyn_tmp/$1" \
  --package="$rigyn_tmp/$2" \
  --package="$rigyn_tmp/$3" \
  --package="$rigyn_tmp/$4" \
  -- rigyn self-install </dev/null

printf 'Rigyn %s was installed from its verified GitHub release.\n' "$rigyn_version"
