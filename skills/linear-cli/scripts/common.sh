#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: ${name}" >&2
    exit 1
  fi
}

append_workspace_args() {
  local -n ref="$1"
  if [[ -z "${LINEAR_API_KEY:-}" && -n "${LINEAR_WORKSPACE:-}" ]]; then
    ref+=(-w "${LINEAR_WORKSPACE}")
  fi
}

append_team_args() {
  local -n ref="$1"
  require_env "LINEAR_TEAM_KEY"
  ref+=(--team "${LINEAR_TEAM_KEY}")
}
