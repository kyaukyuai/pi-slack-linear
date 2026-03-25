#!/usr/bin/env bash
set -euo pipefail

workspace_dir="${WORKSPACE_DIR:-/workspace}"
bot_uid="${BOT_UID:-}"
bot_gid="${BOT_GID:-}"

ensure_dir() {
  local dir="$1"
  mkdir -p "$dir"
}

fix_dir_ownership() {
  local dir="$1"
  if [[ -e "$dir" ]]; then
    chown -R "${bot_uid}:${bot_gid}" "$dir" || true
  fi
}

if [[ "$(id -u)" == "0" && -n "$bot_uid" && -n "$bot_gid" ]]; then
  ensure_dir "$workspace_dir"
  ensure_dir "$workspace_dir/system"
  ensure_dir "$workspace_dir/threads"
  chown "${bot_uid}:${bot_gid}" "$workspace_dir" || true
  fix_dir_ownership "$workspace_dir/system"
  fix_dir_ownership "$workspace_dir/threads"
  exec gosu "${bot_uid}:${bot_gid}" "$@"
fi

exec "$@"
