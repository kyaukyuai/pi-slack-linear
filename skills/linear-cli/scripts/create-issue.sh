#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

require_env "LINEAR_API_KEY"

title=""
description_file=""
state=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)
      title="${2:-}"
      shift 2
      ;;
    --description-file)
      description_file="${2:-}"
      shift 2
      ;;
    --state)
      state="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${title}" ]]; then
  echo "--title is required" >&2
  exit 1
fi

if [[ -z "${description_file}" ]]; then
  echo "--description-file is required" >&2
  exit 1
fi

cmd=(linear issue create --no-interactive --title "${title}" --description-file "${description_file}")
append_workspace_args cmd
append_team_args cmd

if [[ -n "${state}" ]]; then
  cmd+=(--state "${state}")
fi

"${cmd[@]}"
