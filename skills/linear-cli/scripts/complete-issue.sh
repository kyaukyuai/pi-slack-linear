#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

require_env "LINEAR_API_KEY"

issue_id="${1:-}"
if [[ -z "${issue_id}" ]]; then
  echo "Issue ID is required" >&2
  exit 1
fi

cmd=(linear issue move "${issue_id}" completed)
append_workspace_args cmd

"${cmd[@]}"
