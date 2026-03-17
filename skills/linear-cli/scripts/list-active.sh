#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

require_env "LINEAR_API_KEY"

limit="20"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)
      limit="${2:-20}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

cmd=(linear issue list --all-assignees --limit "${limit}" -s unstarted -s started)
append_workspace_args cmd
append_team_args cmd

"${cmd[@]}"
