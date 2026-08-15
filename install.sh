#!/bin/sh
set -eu

umask 077

rigyn_fail() {
  printf 'rigyn install: %s\n' "$*" >&2
  exit 1
}

for rigyn_command in curl tar mktemp uname mkdir mv ln chmod grep awk cmp cp readlink rm rmdir sleep wc ls; do
  command -v "$rigyn_command" >/dev/null 2>&1 || rigyn_fail "$rigyn_command is required"
done

rigyn_release_root=https://github.com/rigyn/rigyn/releases
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
printf '%s\n' "$rigyn_tag" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' \
  || rigyn_fail "GitHub returned an invalid release tag"
rigyn_version=${rigyn_tag#v}

case "$(uname -s)" in
  Linux) rigyn_platform=linux ;;
  Darwin) rigyn_platform=darwin ;;
  *) rigyn_fail "standalone releases support Linux and macOS; use install.ps1 on Windows" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) rigyn_arch=x64 ;;
  arm64|aarch64) rigyn_arch=arm64 ;;
  *) rigyn_fail "standalone releases support x64 and arm64" ;;
esac

rigyn_tmp_base=${TMPDIR:-/tmp}
[ -d "$rigyn_tmp_base" ] || rigyn_fail "temporary directory does not exist: $rigyn_tmp_base"
rigyn_tmp=$(mktemp -d "$rigyn_tmp_base/rigyn-install.XXXXXX") || rigyn_fail "could not create a private temporary directory"
rigyn_transaction_committed=0
rigyn_runtime_commit_started=0
rigyn_runtime_restore_failed=0
rigyn_launcher_commit_started=0
rigyn_launcher_had_previous=0
rigyn_launcher_restore_failed=0
rigyn_command_commit_started=0
rigyn_command_had_previous=0
rigyn_command_restore_failed=0
rigyn_created_agents=0
rigyn_created_settings=0
rigyn_runtime_transaction_active=0
rigyn_runtime_transaction_record=
rigyn_runtime_transaction_record_temp=
rigyn_lifecycle_lock=
rigyn_lifecycle_owner=
rigyn_lifecycle_lock_acquired=0
rigyn_cleanup() {
  if [ "$rigyn_transaction_committed" -ne 1 ]; then
    if [ "$rigyn_command_commit_started" -eq 1 ] && [ -n "${rigyn_command:-}" ]; then
      if [ "$rigyn_command_had_previous" -eq 1 ] \
        && { [ -e "${rigyn_command_backup:-}" ] || [ -L "${rigyn_command_backup:-}" ]; }; then
        rm -f -- "$rigyn_command" 2>/dev/null || :
        if ! mv "$rigyn_command_backup" "$rigyn_command" 2>/dev/null; then
          rigyn_command_restore_failed=1
          printf 'rigyn install: warning: could not restore the previous rigyn command; backup preserved at %s\n' \
            "$rigyn_command_backup" >&2
        fi
      elif [ -L "$rigyn_command" ] && [ "$(readlink "$rigyn_command" 2>/dev/null || :)" = "${rigyn_launcher:-}" ]; then
        rm -f -- "$rigyn_command" 2>/dev/null || :
      fi
    fi
    if [ "$rigyn_launcher_commit_started" -eq 1 ] && [ -n "${rigyn_launcher:-}" ]; then
      if [ "$rigyn_launcher_had_previous" -eq 1 ] \
        && { [ -e "${rigyn_launcher_backup:-}" ] || [ -L "${rigyn_launcher_backup:-}" ]; }; then
        rm -f -- "$rigyn_launcher" 2>/dev/null || :
        if ! mv "$rigyn_launcher_backup" "$rigyn_launcher" 2>/dev/null; then
          rigyn_launcher_restore_failed=1
          printf 'rigyn install: warning: could not restore the previous rigyn launcher; backup preserved at %s\n' \
            "$rigyn_launcher_backup" >&2
        fi
      elif [ -L "$rigyn_launcher" ] && [ "$(readlink "$rigyn_launcher" 2>/dev/null || :)" = "${rigyn_target:-}/bin/rigyn" ]; then
        rm -f -- "$rigyn_launcher" 2>/dev/null || :
      fi
    fi
    if [ "$rigyn_created_agents" -eq 1 ]; then
      rm -f -- "${rigyn_home:-}/AGENTS.md" 2>/dev/null || :
    fi
    if [ "$rigyn_created_settings" -eq 1 ]; then
      rm -f -- "${rigyn_home:-}/config.json" 2>/dev/null || :
    fi
    if [ "$rigyn_runtime_commit_started" -eq 1 ] && [ -n "${rigyn_target:-}" ]; then
      if [ -d "$rigyn_target" ] && [ ! -L "$rigyn_target" ]; then
        rm -rf -- "$rigyn_target" 2>/dev/null || :
      fi
      if [ -d "${rigyn_backup:-}" ] && [ ! -e "$rigyn_target" ] && [ ! -L "$rigyn_target" ]; then
        if ! mv "$rigyn_backup" "$rigyn_target" 2>/dev/null; then
          rigyn_runtime_restore_failed=1
          printf 'rigyn install: warning: could not restore the previous standalone runtime; backup preserved at %s\n' \
            "$rigyn_backup" >&2
        fi
      fi
    fi
    if [ "$rigyn_runtime_transaction_active" -eq 1 ] \
      && [ "$rigyn_runtime_restore_failed" -ne 1 ] \
      && [ -n "${rigyn_runtime_transaction_record:-}" ]; then
      rm -f -- "$rigyn_runtime_transaction_record" 2>/dev/null || :
      rigyn_runtime_transaction_active=0
    fi
  fi
  if [ -n "${rigyn_runtime_transaction_record_temp:-}" ] \
    && [ -n "${rigyn_runtime_root:-}" ]; then
    case "$rigyn_runtime_transaction_record_temp" in
      "$rigyn_runtime_root"/.rigyn-install-record.*)
        rm -f -- "$rigyn_runtime_transaction_record_temp" 2>/dev/null || :
        ;;
    esac
  fi
  if [ -n "${rigyn_stage_parent:-}" ] && [ -n "${rigyn_runtime_root:-}" ]; then
    case "$rigyn_stage_parent" in
      "$rigyn_runtime_root"/.rigyn-stage.*)
        [ ! -d "$rigyn_stage_parent" ] || [ -L "$rigyn_stage_parent" ] || rm -rf -- "$rigyn_stage_parent"
        ;;
    esac
  fi
  if [ -n "${rigyn_backup_parent:-}" ] && [ -n "${rigyn_runtime_root:-}" ]; then
    case "$rigyn_backup_parent" in
      "$rigyn_runtime_root"/.rigyn-backup.*)
        if [ "$rigyn_runtime_restore_failed" -ne 1 ] \
          && { [ "$rigyn_transaction_committed" -eq 1 ] || [ ! -d "${rigyn_backup:-}" ]; }; then
          [ ! -d "$rigyn_backup_parent" ] || [ -L "$rigyn_backup_parent" ] || rm -rf -- "$rigyn_backup_parent"
        fi
        ;;
    esac
  fi
  if [ -n "${rigyn_link_stage:-}" ] && [ -n "${rigyn_launcher_dir:-}" ]; then
    case "$rigyn_link_stage" in
      "$rigyn_launcher_dir"/.rigyn-link.*)
        if [ "$rigyn_launcher_restore_failed" -ne 1 ]; then
          [ ! -d "$rigyn_link_stage" ] || [ -L "$rigyn_link_stage" ] || rm -rf -- "$rigyn_link_stage"
        fi
        ;;
    esac
  fi
  if [ -n "${rigyn_command_stage:-}" ] && [ -n "${rigyn_command_dir:-}" ]; then
    case "$rigyn_command_stage" in
      "$rigyn_command_dir"/.rigyn-command.*)
        if [ "$rigyn_command_restore_failed" -ne 1 ]; then
          [ ! -d "$rigyn_command_stage" ] || [ -L "$rigyn_command_stage" ] || rm -rf -- "$rigyn_command_stage"
        fi
        ;;
      esac
  fi
  if [ "$rigyn_lifecycle_lock_acquired" -eq 1 ] \
    && [ -f "$rigyn_lifecycle_lock" ] \
    && [ ! -L "$rigyn_lifecycle_lock" ] \
    && [ -f "$rigyn_lifecycle_owner" ] \
    && cmp -s "$rigyn_lifecycle_owner" "$rigyn_lifecycle_lock"; then
    rm -f -- "$rigyn_lifecycle_lock" 2>/dev/null || :
    rigyn_lifecycle_lock_acquired=0
  fi
  case "${rigyn_tmp:-}" in
    "$rigyn_tmp_base"/rigyn-install.*)
      [ ! -d "$rigyn_tmp" ] || rm -rf -- "$rigyn_tmp"
      ;;
  esac
}
trap rigyn_cleanup 0
trap 'exit 1' HUP INT TERM

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

rigyn_validate_scaffold_destination() {
  rigyn_scaffold_path=$1
  rigyn_scaffold_label=$2
  if [ -e "$rigyn_scaffold_path" ] || [ -L "$rigyn_scaffold_path" ]; then
    [ -f "$rigyn_scaffold_path" ] && [ ! -L "$rigyn_scaffold_path" ] \
      || rigyn_fail "$rigyn_scaffold_label must be a regular file: $rigyn_scaffold_path"
  fi
}

rigyn_json_string() {
  awk '
    BEGIN { ORS = ""; printf "\"" }
    {
      if (NR > 1) printf "\\n"
      for (position = 1; position <= length($0); position += 1) {
        character = substr($0, position, 1)
        if (character == "\\") printf "\\\\"
        else if (character == "\"") printf "\\\""
        else if (character == "\t") printf "\\t"
        else if (character == "\r") printf "\\r"
        else printf "%s", character
      }
    }
    END { print "\"" }
  '
}

rigyn_record_field() {
  rigyn_record_path=$1
  rigyn_record_name=$2
  awk -v name="$rigyn_record_name" '
    {
      marker = "\"" name "\":\""
      start = index($0, marker)
      if (start == 0) exit 1
      value = substr($0, start + length(marker))
      finish = index(value, "\"")
      if (finish == 0) exit 1
      print substr(value, 1, finish - 1)
      exit
    }
  ' "$rigyn_record_path"
}

rigyn_validate_recoverable_standalone_root() {
  rigyn_recovery_root=$1
  rigyn_recovery_runtime=$2
  [ -d "$rigyn_recovery_root" ] && [ ! -L "$rigyn_recovery_root" ] \
    || rigyn_fail "interrupted standalone uninstall root is unsafe: $rigyn_recovery_root"
  [ ! -e "$rigyn_recovery_root/.installation.json" ] \
    && [ ! -L "$rigyn_recovery_root/.installation.json" ] \
    || rigyn_fail "interrupted standalone uninstall belongs to a source-built installation"
  rigyn_recovery_runtime_root="$rigyn_recovery_root/runtime"
  rigyn_recovery_target="$rigyn_recovery_runtime_root/$rigyn_recovery_runtime"
  [ -d "$rigyn_recovery_runtime_root" ] && [ ! -L "$rigyn_recovery_runtime_root" ] \
    && [ -d "$rigyn_recovery_target" ] && [ ! -L "$rigyn_recovery_target" ] \
    || rigyn_fail "interrupted standalone uninstall runtime is unsafe: $rigyn_recovery_target"
  rigyn_recovery_metadata="$rigyn_recovery_target/BUILD-METADATA.json"
  [ -f "$rigyn_recovery_metadata" ] && [ ! -L "$rigyn_recovery_metadata" ] \
    || rigyn_fail "interrupted standalone uninstall metadata is unsafe: $rigyn_recovery_metadata"
  rigyn_recovery_metadata_size=$(wc -c < "$rigyn_recovery_metadata") \
    || rigyn_fail "could not inspect interrupted standalone uninstall metadata"
  [ "$rigyn_recovery_metadata_size" -le 65536 ] \
    || rigyn_fail "interrupted standalone uninstall metadata is unsafe: $rigyn_recovery_metadata"
  rigyn_recovery_version=${rigyn_recovery_runtime#rigyn-v}
  rigyn_recovery_version=${rigyn_recovery_version%-$rigyn_platform-$rigyn_arch}
  grep -Eq '"product"[[:space:]]*:[[:space:]]*"rigyn"' "$rigyn_recovery_metadata" \
    && grep -Eq '"version"[[:space:]]*:[[:space:]]*"'"$rigyn_recovery_version"'"' "$rigyn_recovery_metadata" \
    && grep -Eq '"platform"[[:space:]]*:[[:space:]]*"'"$rigyn_platform"'"' "$rigyn_recovery_metadata" \
    && grep -Eq '"arch"[[:space:]]*:[[:space:]]*"'"$rigyn_arch"'"' "$rigyn_recovery_metadata" \
    || rigyn_fail "interrupted standalone uninstall metadata does not identify this installation"
  rigyn_recovery_runtime_launcher="$rigyn_recovery_target/bin/rigyn"
  rigyn_recovery_launcher="$rigyn_recovery_root/bin/rigyn"
  [ -f "$rigyn_recovery_runtime_launcher" ] && [ ! -L "$rigyn_recovery_runtime_launcher" ] \
    && [ -L "$rigyn_recovery_launcher" ] \
    && [ "$(readlink "$rigyn_recovery_launcher")" = "$rigyn_install_root/runtime/$rigyn_recovery_runtime/bin/rigyn" ] \
    || rigyn_fail "interrupted standalone uninstall launcher ownership check failed"
}

rigyn_recover_interrupted_standalone_uninstall() {
  rigyn_uninstall_record="$rigyn_install_root.uninstall.json"
  rigyn_uninstall_tombstone="$rigyn_install_root.uninstalling"
  if [ ! -e "$rigyn_uninstall_record" ] && [ ! -L "$rigyn_uninstall_record" ]; then
    [ ! -e "$rigyn_uninstall_tombstone" ] && [ ! -L "$rigyn_uninstall_tombstone" ] \
      || rigyn_fail "standalone uninstall tombstone exists without its recovery record: $rigyn_uninstall_tombstone"
    return
  fi
  [ -f "$rigyn_uninstall_record" ] && [ ! -L "$rigyn_uninstall_record" ] \
    || rigyn_fail "standalone uninstall transaction is unsafe: $rigyn_uninstall_record"
  rigyn_uninstall_record_size=$(wc -c < "$rigyn_uninstall_record") \
    || rigyn_fail "could not inspect standalone uninstall transaction"
  [ "$rigyn_uninstall_record_size" -le 16384 ] \
    && [ "$(awk 'END { print NR }' "$rigyn_uninstall_record")" -eq 1 ] \
    && grep -Eq '^\{"product":"rigyn","schemaVersion":1,"distribution":"standalone","phase":"(prepared|isolated|command-removed)","runtime":"rigyn-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?-(linux|darwin)-(x64|arm64)"\}$' "$rigyn_uninstall_record" \
    || rigyn_fail "standalone uninstall transaction is invalid: $rigyn_uninstall_record"
  rigyn_uninstall_runtime=$(rigyn_record_field "$rigyn_uninstall_record" runtime) \
    || rigyn_fail "standalone uninstall transaction is invalid: $rigyn_uninstall_record"
  case "$rigyn_uninstall_runtime" in
    *-$rigyn_platform-$rigyn_arch) ;;
    *) rigyn_fail "standalone uninstall transaction targets another platform" ;;
  esac
  if { [ -e "$rigyn_install_root" ] || [ -L "$rigyn_install_root" ]; } \
    && { [ -e "$rigyn_uninstall_tombstone" ] || [ -L "$rigyn_uninstall_tombstone" ]; }; then
    rigyn_fail "interrupted standalone uninstall has both active and tombstone roots"
  fi
  if [ -e "$rigyn_uninstall_tombstone" ] || [ -L "$rigyn_uninstall_tombstone" ]; then
    rigyn_validate_recoverable_standalone_root "$rigyn_uninstall_tombstone" "$rigyn_uninstall_runtime"
    mv "$rigyn_uninstall_tombstone" "$rigyn_install_root" \
      || rigyn_fail "could not restore the interrupted standalone uninstall"
  elif [ -e "$rigyn_install_root" ] || [ -L "$rigyn_install_root" ]; then
    rigyn_validate_recoverable_standalone_root "$rigyn_install_root" "$rigyn_uninstall_runtime"
  fi
  rm -f -- "$rigyn_uninstall_record" \
    || rigyn_fail "could not finish standalone uninstall recovery"
}

rigyn_lock_pid() {
  awk '
    match($0, /"pid":[0-9]+/) {
      value = substr($0, RSTART, RLENGTH)
      sub(/^"pid":/, "", value)
      print value
      exit
    }
  ' "$1"
}

rigyn_acquire_lifecycle_lock() {
  rigyn_lock_attempt=0
  rigyn_invalid_lock_snapshot="$rigyn_tmp/lifecycle-lock.invalid.snapshot"
  while [ "$rigyn_lock_attempt" -lt 30 ]; do
    if (set -C; printf '%s\n' "$rigyn_lifecycle_contents" > "$rigyn_lifecycle_lock") 2>/dev/null; then
      rigyn_lifecycle_lock_acquired=1
      chmod 600 "$rigyn_lifecycle_lock" \
        || rigyn_fail "could not secure the standalone lifecycle lock"
      return
    fi

    rigyn_lock_snapshot="$rigyn_tmp/lifecycle-lock.snapshot"
    if [ -f "$rigyn_lifecycle_lock" ] \
      && [ ! -L "$rigyn_lifecycle_lock" ] \
      && cp "$rigyn_lifecycle_lock" "$rigyn_lock_snapshot" 2>/dev/null; then
      rigyn_existing_pid=$(rigyn_lock_pid "$rigyn_lock_snapshot")
      case "$rigyn_existing_pid" in
        ''|*[!0-9]*) rigyn_existing_pid= ;;
      esac
      if [ -n "$rigyn_existing_pid" ] && ! kill -0 "$rigyn_existing_pid" 2>/dev/null; then
        rm -f -- "$rigyn_invalid_lock_snapshot"
        rigyn_lock_quarantine="$rigyn_lifecycle_lock.stale.$$.$rigyn_lock_attempt"
        if mv "$rigyn_lifecycle_lock" "$rigyn_lock_quarantine" 2>/dev/null; then
          if cmp -s "$rigyn_lock_snapshot" "$rigyn_lock_quarantine"; then
            rm -f -- "$rigyn_lock_quarantine"
            continue
          fi
          if [ ! -e "$rigyn_lifecycle_lock" ] && [ ! -L "$rigyn_lifecycle_lock" ]; then
            mv "$rigyn_lock_quarantine" "$rigyn_lifecycle_lock" 2>/dev/null || :
          fi
        fi
      elif [ -z "$rigyn_existing_pid" ]; then
        if [ -f "$rigyn_invalid_lock_snapshot" ] \
          && cmp -s "$rigyn_invalid_lock_snapshot" "$rigyn_lock_snapshot"; then
          rigyn_lock_quarantine="$rigyn_lifecycle_lock.stale.$$.$rigyn_lock_attempt"
          if mv "$rigyn_lifecycle_lock" "$rigyn_lock_quarantine" 2>/dev/null; then
            if cmp -s "$rigyn_lock_snapshot" "$rigyn_lock_quarantine"; then
              rm -f -- "$rigyn_lock_quarantine" "$rigyn_invalid_lock_snapshot"
              continue
            fi
            if [ ! -e "$rigyn_lifecycle_lock" ] && [ ! -L "$rigyn_lifecycle_lock" ]; then
              mv "$rigyn_lock_quarantine" "$rigyn_lifecycle_lock" 2>/dev/null || :
            fi
          fi
        else
          cp "$rigyn_lock_snapshot" "$rigyn_invalid_lock_snapshot" 2>/dev/null || :
        fi
      else
        rm -f -- "$rigyn_invalid_lock_snapshot"
      fi
    else
      rm -f -- "$rigyn_invalid_lock_snapshot"
    fi
    rigyn_lock_attempt=$((rigyn_lock_attempt + 1))
    sleep 1
  done
  rigyn_fail "timed out waiting for another rigyn lifecycle operation at $rigyn_install_root"
}

rigyn_asset_root="$rigyn_release_root/download/$rigyn_tag"
rigyn_checksums="$rigyn_tmp/SHA256SUMS"
rigyn_archive="rigyn-v$rigyn_version-$rigyn_platform-$rigyn_arch.tar.gz"
rigyn_archive_path="$rigyn_tmp/$rigyn_archive"
rigyn_download "$rigyn_asset_root/SHA256SUMS" "$rigyn_checksums" 1048576 \
  || rigyn_fail "could not download SHA256SUMS"
rigyn_download "$rigyn_asset_root/$rigyn_archive" "$rigyn_archive_path" 1073741824 \
  || rigyn_fail "could not download $rigyn_archive"

rigyn_expected=$(
  awk -v name="$rigyn_archive" '
    $2 == name {
      count += 1
      value = $1
    }
    END {
      if (count != 1) exit 1
      print value
    }
  ' "$rigyn_checksums"
) || rigyn_fail "SHA256SUMS must list $rigyn_archive exactly once"
printf '%s\n' "$rigyn_expected" | grep -Eq '^[a-f0-9]{64}$' \
  || rigyn_fail "SHA256SUMS contains an invalid digest for $rigyn_archive"

if command -v sha256sum >/dev/null 2>&1; then
  rigyn_hash_tool=sha256sum
  rigyn_actual=$(sha256sum "$rigyn_archive_path" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  rigyn_hash_tool=shasum
  rigyn_actual=$(shasum -a 256 "$rigyn_archive_path" | awk '{ print $1 }')
elif command -v openssl >/dev/null 2>&1; then
  rigyn_hash_tool=openssl
  rigyn_actual=$(openssl dgst -sha256 "$rigyn_archive_path" | awk '{ print $NF }')
else
  rigyn_fail "sha256sum, shasum, or openssl is required to verify the release"
fi
[ "$rigyn_actual" = "$rigyn_expected" ] || rigyn_fail "checksum mismatch for $rigyn_archive"

rigyn_archive_root=${rigyn_archive%.tar.gz}
rigyn_listing="$rigyn_tmp/archive.list"
rigyn_verbose_listing="$rigyn_tmp/archive.verbose.list"
tar -tzf "$rigyn_archive_path" > "$rigyn_listing" \
  || rigyn_fail "$rigyn_archive is not a readable tar.gz archive"
tar -tvzf "$rigyn_archive_path" > "$rigyn_verbose_listing" \
  || rigyn_fail "$rigyn_archive metadata could not be inspected"
while IFS= read -r rigyn_entry_metadata; do
  case "$rigyn_entry_metadata" in
    -*|d*) ;;
    *) rigyn_fail "$rigyn_archive contains an unsupported entry type" ;;
  esac
done < "$rigyn_verbose_listing"
while IFS= read -r rigyn_entry; do
  [ -n "$rigyn_entry" ] || rigyn_fail "$rigyn_archive contains an empty path"
  case "$rigyn_entry" in
    "$rigyn_archive_root"|"$rigyn_archive_root/"|"$rigyn_archive_root/"*) ;;
    *) rigyn_fail "$rigyn_archive contains a path outside its release root" ;;
  esac
  case "$rigyn_entry" in
    */../*|*/..|../*|*/./*|*/.|./*|*//*)
      rigyn_fail "$rigyn_archive contains an unsafe path"
      ;;
  esac
done < "$rigyn_listing"

rigyn_extract="$rigyn_tmp/extract"
mkdir -m 700 "$rigyn_extract"
tar -xzf "$rigyn_archive_path" -C "$rigyn_extract" \
  || rigyn_fail "could not extract $rigyn_archive"
rigyn_payload="$rigyn_extract/$rigyn_archive_root"
[ -d "$rigyn_payload" ] && [ ! -L "$rigyn_payload" ] \
  || rigyn_fail "$rigyn_archive is missing its release root"
for rigyn_required in bin/rigyn BUILD-METADATA.json lib/node_modules/rigyn/resources/AGENTS.md lib/node_modules/rigyn/resources/config.example.json; do
  [ -f "$rigyn_payload/$rigyn_required" ] && [ ! -L "$rigyn_payload/$rigyn_required" ] \
    || rigyn_fail "$rigyn_archive is missing $rigyn_required"
done

rigyn_install_root="$HOME/.rigyn"
rigyn_lifecycle_lock="$rigyn_install_root.lifecycle.lock"
rigyn_lock_seed="$rigyn_tmp/lifecycle-lock.seed"
rigyn_lifecycle_owner="$rigyn_tmp/lifecycle-lock.owner"
printf '%s\n%s\n%s\n' "$$" "$rigyn_tmp" "$rigyn_expected" > "$rigyn_lock_seed"
case "$rigyn_hash_tool" in
  sha256sum) rigyn_lock_digest=$(sha256sum "$rigyn_lock_seed" | awk '{ print $1 }') ;;
  shasum) rigyn_lock_digest=$(shasum -a 256 "$rigyn_lock_seed" | awk '{ print $1 }') ;;
  openssl) rigyn_lock_digest=$(openssl dgst -sha256 "$rigyn_lock_seed" | awk '{ print $NF }') ;;
esac
rigyn_lock_token=$(printf '%s\n' "$rigyn_lock_digest" | awk '{ print substr($0, 1, 32) }')
rigyn_lock_root=$(printf '%s\n' "$rigyn_install_root" | rigyn_json_string)
rigyn_lifecycle_contents=$(printf \
  '{"schemaVersion":1,"pid":%s,"token":"%s","createdAt":0,"installRoot":%s}' \
  "$$" "$rigyn_lock_token" "$rigyn_lock_root")
printf '%s\n' "$rigyn_lifecycle_contents" > "$rigyn_lifecycle_owner"
rigyn_acquire_lifecycle_lock
rigyn_recover_interrupted_standalone_uninstall

mkdir -p -m 700 "$rigyn_install_root"
[ -d "$rigyn_install_root" ] && [ ! -L "$rigyn_install_root" ] \
  || rigyn_fail "standalone installation root is not a safe directory: $rigyn_install_root"
for rigyn_source_owned_path in \
  .installation.json \
  .install-transaction.json \
  .app-install \
  .build-install \
  .app-previous \
  app
do
  if [ -e "$rigyn_install_root/$rigyn_source_owned_path" ] \
    || [ -L "$rigyn_install_root/$rigyn_source_owned_path" ]; then
    rigyn_fail "a source-built installation owns $rigyn_install_root; preserve ~/.rigyn and follow the state-preserving transition docs before changing installation methods"
  fi
done

rigyn_runtime_leases="$rigyn_install_root/.runtime-leases"
if [ -e "$rigyn_runtime_leases" ] || [ -L "$rigyn_runtime_leases" ]; then
  [ -d "$rigyn_runtime_leases" ] && [ ! -L "$rigyn_runtime_leases" ] \
    || rigyn_fail "standalone runtime lease path is unsafe: $rigyn_runtime_leases"
  rigyn_runtime_lease_entries=$(LC_ALL=C ls -A "$rigyn_runtime_leases") \
    || rigyn_fail "could not inspect standalone runtime leases"
  if [ -n "$rigyn_runtime_lease_entries" ]; then
    while IFS= read -r rigyn_runtime_lease_entry; do
      printf '%s\n' "$rigyn_runtime_lease_entry" | grep -Eq '^[a-f0-9]{32}\.json$' \
        || rigyn_fail "standalone runtime lease entry is unsafe: $rigyn_runtime_lease_entry"
      rigyn_runtime_lease_path="$rigyn_runtime_leases/$rigyn_runtime_lease_entry"
      [ -f "$rigyn_runtime_lease_path" ] && [ ! -L "$rigyn_runtime_lease_path" ] \
        || rigyn_fail "standalone runtime lease entry is unsafe: $rigyn_runtime_lease_entry"
      rigyn_runtime_lease_size=$(wc -c < "$rigyn_runtime_lease_path") \
        || rigyn_fail "could not inspect standalone runtime lease: $rigyn_runtime_lease_entry"
      [ "$rigyn_runtime_lease_size" -le 16384 ] \
        || rigyn_fail "standalone runtime lease entry is unsafe: $rigyn_runtime_lease_entry"
      rigyn_runtime_lease_snapshot="$rigyn_tmp/runtime-lease.$rigyn_runtime_lease_entry"
      cp "$rigyn_runtime_lease_path" "$rigyn_runtime_lease_snapshot" \
        || rigyn_fail "could not inspect standalone runtime lease: $rigyn_runtime_lease_entry"
      [ "$(awk 'END { print NR }' "$rigyn_runtime_lease_snapshot")" -eq 1 ] \
        && grep -Eq '^\{"schemaVersion":1,"pid":[1-9][0-9]*,"lease":"[a-f0-9]{32}","createdAt":[0-9]+,"installationId":"[a-f0-9]{32}"\}$' "$rigyn_runtime_lease_snapshot" \
        || rigyn_fail "standalone runtime lease entry is invalid: $rigyn_runtime_lease_entry"
      rigyn_runtime_lease_pid=$(rigyn_lock_pid "$rigyn_runtime_lease_snapshot")
      rigyn_runtime_lease_name=$(awk '
        match($0, /"lease":"[a-f0-9]+"/) {
          value = substr($0, RSTART, RLENGTH)
          sub(/^"lease":"/, "", value)
          sub(/"$/, "", value)
          print value
          exit
        }
      ' "$rigyn_runtime_lease_snapshot")
      [ "$rigyn_runtime_lease_entry" = "$rigyn_runtime_lease_name.json" ] \
        || rigyn_fail "standalone runtime lease entry is invalid: $rigyn_runtime_lease_entry"
      if kill -0 "$rigyn_runtime_lease_pid" 2>/dev/null; then
        rigyn_fail "close every running rigyn process before updating the standalone installation"
      fi
      cmp -s "$rigyn_runtime_lease_snapshot" "$rigyn_runtime_lease_path" \
        || rigyn_fail "standalone runtime lease changed while the installation was being updated"
      rm -f -- "$rigyn_runtime_lease_path" \
        || rigyn_fail "could not remove stale standalone runtime lease: $rigyn_runtime_lease_entry"
    done <<EOF
$rigyn_runtime_lease_entries
EOF
  fi
fi

rigyn_runtime_root="$rigyn_install_root/runtime"
rigyn_target="$rigyn_runtime_root/$rigyn_archive_root"
mkdir -p -m 700 "$rigyn_runtime_root"
[ -d "$rigyn_runtime_root" ] && [ ! -L "$rigyn_runtime_root" ] \
  || rigyn_fail "standalone runtime root is not a safe directory: $rigyn_runtime_root"

rigyn_runtime_transaction_record="$rigyn_runtime_root/.rigyn-install-transaction.json"

rigyn_write_runtime_transaction() {
  rigyn_runtime_transaction_phase=$1
  rigyn_runtime_transaction_runtime=$2
  rigyn_runtime_transaction_stage=$3
  rigyn_runtime_transaction_backup=$4
  rigyn_runtime_transaction_previous=$5
  rigyn_runtime_transaction_record_temp=$(mktemp "$rigyn_runtime_root/.rigyn-install-record.XXXXXX") \
    || rigyn_fail "could not stage the standalone runtime transaction"
  printf '{"product":"rigyn","schemaVersion":1,"distribution":"standalone","phase":"%s","runtime":"%s","stage":"%s","backup":%s,"hadPrevious":%s}\n' \
    "$rigyn_runtime_transaction_phase" \
    "$rigyn_runtime_transaction_runtime" \
    "$rigyn_runtime_transaction_stage" \
    "$rigyn_runtime_transaction_backup" \
    "$rigyn_runtime_transaction_previous" > "$rigyn_runtime_transaction_record_temp" \
    || rigyn_fail "could not write the standalone runtime transaction"
  chmod 600 "$rigyn_runtime_transaction_record_temp" \
    || rigyn_fail "could not secure the standalone runtime transaction"
  mv -f "$rigyn_runtime_transaction_record_temp" "$rigyn_runtime_transaction_record" \
    || rigyn_fail "could not publish the standalone runtime transaction"
  rigyn_runtime_transaction_record_temp=
  if [ "$rigyn_runtime_transaction_phase" = committed ]; then
    rigyn_transaction_committed=1
  fi
  rigyn_runtime_transaction_active=1
}

rigyn_remove_recovery_tree() {
  rigyn_recovery_tree=$1
  rigyn_recovery_prefix=$2
  case "$rigyn_recovery_tree" in
    "$rigyn_runtime_root"/"$rigyn_recovery_prefix".*) ;;
    *) rigyn_fail "standalone runtime transaction path is unsafe: $rigyn_recovery_tree" ;;
  esac
  if [ -e "$rigyn_recovery_tree" ] || [ -L "$rigyn_recovery_tree" ]; then
    [ -d "$rigyn_recovery_tree" ] && [ ! -L "$rigyn_recovery_tree" ] \
      || rigyn_fail "standalone runtime transaction path is unsafe: $rigyn_recovery_tree"
    rm -rf -- "$rigyn_recovery_tree" \
      || rigyn_fail "could not remove standalone runtime transaction residue: $rigyn_recovery_tree"
  fi
}

rigyn_recover_runtime_transaction() {
  if [ ! -e "$rigyn_runtime_transaction_record" ] && [ ! -L "$rigyn_runtime_transaction_record" ]; then
    return
  fi
  [ -f "$rigyn_runtime_transaction_record" ] && [ ! -L "$rigyn_runtime_transaction_record" ] \
    || rigyn_fail "standalone runtime transaction is unsafe: $rigyn_runtime_transaction_record"
  rigyn_runtime_record_size=$(wc -c < "$rigyn_runtime_transaction_record") \
    || rigyn_fail "could not inspect standalone runtime transaction"
  [ "$rigyn_runtime_record_size" -le 16384 ] \
    && [ "$(awk 'END { print NR }' "$rigyn_runtime_transaction_record")" -eq 1 ] \
    && grep -Eq '^\{"product":"rigyn","schemaVersion":1,"distribution":"standalone","phase":"(prepared|previous-isolated|replacement-installed|committed)","runtime":"rigyn-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?-(linux|darwin)-(x64|arm64)","stage":"\.rigyn-stage\.[A-Za-z0-9]+","backup":(null|"\.rigyn-backup\.[A-Za-z0-9]+"),"hadPrevious":(true|false)\}$' "$rigyn_runtime_transaction_record" \
    || rigyn_fail "standalone runtime transaction is invalid: $rigyn_runtime_transaction_record"
  rigyn_runtime_record_phase=$(rigyn_record_field "$rigyn_runtime_transaction_record" phase) \
    || rigyn_fail "standalone runtime transaction is invalid: $rigyn_runtime_transaction_record"
  rigyn_runtime_record_runtime=$(rigyn_record_field "$rigyn_runtime_transaction_record" runtime) \
    || rigyn_fail "standalone runtime transaction is invalid: $rigyn_runtime_transaction_record"
  rigyn_runtime_record_stage=$(rigyn_record_field "$rigyn_runtime_transaction_record" stage) \
    || rigyn_fail "standalone runtime transaction is invalid: $rigyn_runtime_transaction_record"
  case "$rigyn_runtime_record_runtime" in
    *-$rigyn_platform-$rigyn_arch) ;;
    *) rigyn_fail "standalone runtime transaction targets another platform" ;;
  esac
  if grep -q '"hadPrevious":true}' "$rigyn_runtime_transaction_record"; then
    rigyn_runtime_record_had_previous=1
    rigyn_runtime_record_backup=$(rigyn_record_field "$rigyn_runtime_transaction_record" backup) \
      || rigyn_fail "standalone runtime transaction is invalid: $rigyn_runtime_transaction_record"
  else
    rigyn_runtime_record_had_previous=0
    grep -q '"backup":null,"hadPrevious":false}' "$rigyn_runtime_transaction_record" \
      || rigyn_fail "standalone runtime transaction is invalid: $rigyn_runtime_transaction_record"
    rigyn_runtime_record_backup=
  fi
  rigyn_runtime_record_target="$rigyn_runtime_root/$rigyn_runtime_record_runtime"
  rigyn_runtime_record_stage_parent="$rigyn_runtime_root/$rigyn_runtime_record_stage"
  if [ -e "$rigyn_runtime_record_target" ] || [ -L "$rigyn_runtime_record_target" ]; then
    [ -d "$rigyn_runtime_record_target" ] && [ ! -L "$rigyn_runtime_record_target" ] \
      || rigyn_fail "standalone runtime transaction target is unsafe: $rigyn_runtime_record_target"
  fi
  if [ "$rigyn_runtime_record_had_previous" -eq 1 ]; then
    rigyn_runtime_record_backup_parent="$rigyn_runtime_root/$rigyn_runtime_record_backup"
    rigyn_runtime_record_backup_target="$rigyn_runtime_record_backup_parent/$rigyn_runtime_record_runtime"
    if [ -e "$rigyn_runtime_record_backup_parent" ] || [ -L "$rigyn_runtime_record_backup_parent" ]; then
      [ -d "$rigyn_runtime_record_backup_parent" ] && [ ! -L "$rigyn_runtime_record_backup_parent" ] \
        || rigyn_fail "standalone runtime transaction backup is unsafe: $rigyn_runtime_record_backup_parent"
    fi
    if [ -e "$rigyn_runtime_record_backup_target" ] || [ -L "$rigyn_runtime_record_backup_target" ]; then
      [ -d "$rigyn_runtime_record_backup_target" ] && [ ! -L "$rigyn_runtime_record_backup_target" ] \
        || rigyn_fail "standalone runtime transaction backup is unsafe: $rigyn_runtime_record_backup_target"
      if [ "$rigyn_runtime_record_phase" = committed ]; then
        rigyn_remove_recovery_tree "$rigyn_runtime_record_backup_parent" .rigyn-backup
      else
        if [ -e "$rigyn_runtime_record_target" ] || [ -L "$rigyn_runtime_record_target" ]; then
          rm -rf -- "$rigyn_runtime_record_target" \
            || rigyn_fail "could not discard an interrupted standalone runtime replacement"
        fi
        mv "$rigyn_runtime_record_backup_target" "$rigyn_runtime_record_target" \
          || rigyn_fail "could not restore the previous standalone runtime"
        rmdir "$rigyn_runtime_record_backup_parent" \
          || rigyn_fail "standalone runtime backup contains unexpected residue: $rigyn_runtime_record_backup_parent"
      fi
    elif [ ! -e "$rigyn_runtime_record_target" ] && [ ! -L "$rigyn_runtime_record_target" ]; then
      rigyn_fail "standalone runtime transaction lost both its target and backup"
    elif [ -e "$rigyn_runtime_record_backup_parent" ] || [ -L "$rigyn_runtime_record_backup_parent" ]; then
      rmdir "$rigyn_runtime_record_backup_parent" \
        || rigyn_fail "standalone runtime backup contains unexpected residue: $rigyn_runtime_record_backup_parent"
    fi
  fi
  rigyn_remove_recovery_tree "$rigyn_runtime_record_stage_parent" .rigyn-stage
  rm -f -- "$rigyn_runtime_transaction_record" \
    || rigyn_fail "could not finish standalone runtime transaction recovery"
}

rigyn_recover_runtime_transaction

rigyn_stage_parent=$(mktemp -d "$rigyn_runtime_root/.rigyn-stage.XXXXXX") \
  || rigyn_fail "could not stage the standalone runtime"
rigyn_staged_target="$rigyn_stage_parent/$rigyn_archive_root"
mv "$rigyn_payload" "$rigyn_staged_target" \
  || rigyn_fail "could not stage the verified standalone runtime"

rigyn_is_managed_runtime_link() {
  rigyn_managed_root=$1
  rigyn_managed_link=$2
  case "$rigyn_managed_link" in
    "$rigyn_managed_root"/*/bin/rigyn) ;;
    *) return 1 ;;
  esac
  rigyn_managed_relative=${rigyn_managed_link#"$rigyn_managed_root/"}
  rigyn_managed_runtime=${rigyn_managed_relative%/bin/rigyn}
  case "$rigyn_managed_runtime" in
    */*|.|..) return 1 ;;
  esac
  printf '%s\n' "$rigyn_managed_runtime" \
    | grep -Eq '^rigyn-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?-(linux|darwin)-(x64|arm64)$'
}

rigyn_launcher_dir="$rigyn_install_root/bin"
rigyn_launcher="$rigyn_launcher_dir/rigyn"
mkdir -p -m 700 "$rigyn_launcher_dir"
[ -d "$rigyn_launcher_dir" ] && [ ! -L "$rigyn_launcher_dir" ] \
  || rigyn_fail "launcher directory is not a safe directory: $rigyn_launcher_dir"
if [ -e "$rigyn_launcher" ] || [ -L "$rigyn_launcher" ]; then
  if [ -L "$rigyn_launcher" ]; then
    rigyn_previous_target=$(readlink "$rigyn_launcher")
    rigyn_is_managed_runtime_link "$rigyn_runtime_root" "$rigyn_previous_target" \
      || rigyn_fail "refusing to replace an unmanaged command: $rigyn_launcher"
  else
    rigyn_fail "refusing to replace an unmanaged command: $rigyn_launcher"
  fi
fi
rigyn_link_stage=$(mktemp -d "$rigyn_launcher_dir/.rigyn-link.XXXXXX") \
  || rigyn_fail "could not stage the rigyn command"
rigyn_launcher_backup="$rigyn_link_stage/previous"
if [ -e "$rigyn_launcher" ] || [ -L "$rigyn_launcher" ]; then
  cp -P "$rigyn_launcher" "$rigyn_launcher_backup" \
    || rigyn_fail "could not stage the previous rigyn command"
  rigyn_launcher_had_previous=1
fi
ln -s "$rigyn_target/bin/rigyn" "$rigyn_link_stage/rigyn"

rigyn_command_dir="$HOME/.local/bin"
rigyn_command="$rigyn_command_dir/rigyn"
mkdir -p -m 700 "$rigyn_command_dir"
[ -d "$rigyn_command_dir" ] && [ ! -L "$rigyn_command_dir" ] \
  || rigyn_fail "command directory is not a safe directory: $rigyn_command_dir"
if [ -e "$rigyn_command" ] || [ -L "$rigyn_command" ]; then
  if [ -L "$rigyn_command" ]; then
    rigyn_previous_command_target=$(readlink "$rigyn_command")
    if [ "$rigyn_previous_command_target" != "$rigyn_launcher" ]; then
      if rigyn_is_managed_runtime_link "$rigyn_runtime_root" "$rigyn_previous_command_target"; then
        :
      else
        rigyn_fail "refusing to replace an unmanaged command: $rigyn_command"
      fi
    fi
  elif [ -f "$rigyn_command" ]; then
    rigyn_launcher_escaped=$(
      printf '%s\n' "$rigyn_launcher" \
        | awk '{ gsub(/\047/, "\047\"\047\"\047"); printf "%s", $0 }'
    )
    rigyn_managed_command_expected="$rigyn_tmp/managed-command"
    printf '#!/usr/bin/env sh\n# rigyn managed command\nexec '\''%s'\'' "$@"\n' \
      "$rigyn_launcher_escaped" > "$rigyn_managed_command_expected"
    cmp -s "$rigyn_command" "$rigyn_managed_command_expected" \
      || rigyn_fail "refusing to replace an unmanaged command: $rigyn_command"
  else
    rigyn_fail "refusing to replace an unmanaged command: $rigyn_command"
  fi
fi
rigyn_command_stage=$(mktemp -d "$rigyn_command_dir/.rigyn-command.XXXXXX") \
  || rigyn_fail "could not stage the rigyn command"
rigyn_command_backup="$rigyn_command_stage/previous"
if [ -e "$rigyn_command" ] || [ -L "$rigyn_command" ]; then
  cp -P "$rigyn_command" "$rigyn_command_backup" \
    || rigyn_fail "could not stage the previous rigyn command"
  rigyn_command_had_previous=1
fi
ln -s "$rigyn_launcher" "$rigyn_command_stage/rigyn"

rigyn_home=${RIGYN_HOME:-"$HOME/.rigyn"}
mkdir -p -m 700 "$rigyn_home"
[ -d "$rigyn_home" ] && [ ! -L "$rigyn_home" ] \
  || rigyn_fail "rigyn home is not a safe directory: $rigyn_home"
rigyn_validate_scaffold_destination "$rigyn_home/AGENTS.md" "Agent instructions"
rigyn_validate_scaffold_destination "$rigyn_home/config.json" "Rigyn configuration"
rigyn_resources="$rigyn_target/lib/node_modules/rigyn/resources"

rigyn_backup_parent=
rigyn_runtime_transaction_stage_name=${rigyn_stage_parent##*/}
rigyn_runtime_transaction_backup_json=null
rigyn_runtime_transaction_previous=false
if [ -e "$rigyn_target" ] || [ -L "$rigyn_target" ]; then
  [ -d "$rigyn_target" ] && [ ! -L "$rigyn_target" ] \
    || rigyn_fail "existing standalone runtime is not a safe rigyn installation: $rigyn_target"
  rigyn_backup_parent=$(mktemp -d "$rigyn_runtime_root/.rigyn-backup.XXXXXX") \
    || rigyn_fail "could not stage the previous standalone runtime"
  rigyn_backup="$rigyn_backup_parent/$rigyn_archive_root"
  rigyn_runtime_transaction_backup_name=${rigyn_backup_parent##*/}
  rigyn_runtime_transaction_backup_json="\"$rigyn_runtime_transaction_backup_name\""
  rigyn_runtime_transaction_previous=true
  rigyn_write_runtime_transaction \
    prepared \
    "$rigyn_archive_root" \
    "$rigyn_runtime_transaction_stage_name" \
    "$rigyn_runtime_transaction_backup_json" \
    "$rigyn_runtime_transaction_previous"
  mv "$rigyn_target" "$rigyn_backup" \
    || rigyn_fail "could not stage the previous standalone runtime"
  rigyn_runtime_commit_started=1
  rigyn_write_runtime_transaction \
    previous-isolated \
    "$rigyn_archive_root" \
    "$rigyn_runtime_transaction_stage_name" \
    "$rigyn_runtime_transaction_backup_json" \
    "$rigyn_runtime_transaction_previous"
  if ! mv "$rigyn_staged_target" "$rigyn_target"; then
    if mv "$rigyn_backup" "$rigyn_target"; then
      rm -rf -- "$rigyn_stage_parent" "$rigyn_backup_parent"
      rigyn_stage_parent=
      rigyn_backup_parent=
      rigyn_runtime_commit_started=0
      rigyn_fail "could not replace the standalone runtime; the previous runtime was restored"
    fi
    rigyn_fail "could not replace the standalone runtime; backup preserved at $rigyn_backup"
  fi
  rigyn_write_runtime_transaction \
    replacement-installed \
    "$rigyn_archive_root" \
    "$rigyn_runtime_transaction_stage_name" \
    "$rigyn_runtime_transaction_backup_json" \
    "$rigyn_runtime_transaction_previous"
else
  rigyn_write_runtime_transaction \
    prepared \
    "$rigyn_archive_root" \
    "$rigyn_runtime_transaction_stage_name" \
    "$rigyn_runtime_transaction_backup_json" \
    "$rigyn_runtime_transaction_previous"
  rigyn_runtime_commit_started=1
  mv "$rigyn_staged_target" "$rigyn_target" \
    || rigyn_fail "could not install the standalone runtime"
  rigyn_write_runtime_transaction \
    replacement-installed \
    "$rigyn_archive_root" \
    "$rigyn_runtime_transaction_stage_name" \
    "$rigyn_runtime_transaction_backup_json" \
    "$rigyn_runtime_transaction_previous"
fi
rmdir "$rigyn_stage_parent"
rigyn_stage_parent=

if [ ! -e "$rigyn_home/AGENTS.md" ] && [ ! -L "$rigyn_home/AGENTS.md" ]; then
  rigyn_created_agents=1
  cp "$rigyn_resources/AGENTS.md" "$rigyn_home/AGENTS.md" \
    || rigyn_fail "could not create $rigyn_home/AGENTS.md"
  chmod 600 "$rigyn_home/AGENTS.md" \
    || rigyn_fail "could not secure $rigyn_home/AGENTS.md"
else
  rigyn_validate_scaffold_destination "$rigyn_home/AGENTS.md" "Agent instructions"
fi
if [ ! -e "$rigyn_home/config.json" ] && [ ! -L "$rigyn_home/config.json" ]; then
  rigyn_created_settings=1
  cp "$rigyn_resources/config.example.json" "$rigyn_home/config.json" \
    || rigyn_fail "could not create $rigyn_home/config.json"
  chmod 600 "$rigyn_home/config.json" \
    || rigyn_fail "could not secure $rigyn_home/config.json"
else
  rigyn_validate_scaffold_destination "$rigyn_home/config.json" "Rigyn configuration"
fi

rigyn_launcher_commit_started=1
mv -f "$rigyn_link_stage/rigyn" "$rigyn_launcher" \
  || rigyn_fail "could not install the rigyn launcher"
rigyn_command_commit_started=1
mv -f "$rigyn_command_stage/rigyn" "$rigyn_command" \
  || rigyn_fail "could not install the rigyn command"
if ! rigyn_installed_version=$("$rigyn_command" --version); then
  rigyn_fail "the installed rigyn command failed its version check"
fi
[ "$rigyn_installed_version" = "$rigyn_version" ] \
  || rigyn_fail "the installed rigyn command reported an unexpected version"
rigyn_write_runtime_transaction \
  committed \
  "$rigyn_archive_root" \
  "$rigyn_runtime_transaction_stage_name" \
  "$rigyn_runtime_transaction_backup_json" \
  "$rigyn_runtime_transaction_previous"
if [ -n "$rigyn_backup_parent" ]; then
  rm -rf -- "$rigyn_backup_parent"
  rigyn_backup_parent=
fi
rm -f -- "$rigyn_runtime_transaction_record"
rigyn_runtime_transaction_active=0
rm -rf -- "$rigyn_link_stage"
rigyn_link_stage=
rm -rf -- "$rigyn_command_stage"
rigyn_command_stage=

printf 'rigyn %s was installed from its verified GitHub standalone release.\n' "$rigyn_version"
printf 'rigyn home: %s\n' "$rigyn_install_root"
printf 'Runtime: %s\n' "$rigyn_target"
printf 'Command: %s\n' "$rigyn_command"
case ":${PATH:-}:" in
  *":$rigyn_command_dir:"*) ;;
  *) printf 'Add %s to PATH, then run rigyn.\n' "$rigyn_command_dir" ;;
esac
