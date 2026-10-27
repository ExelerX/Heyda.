#!/usr/bin/env bash
# Runs a build command; if it fails, its errors and last lines become GitHub annotations too
# (see ci-annotate.sh), so a failure can be read without the full job log.
# Usage: bash scripts/ci-run.sh "<title>" <command> [args...]
set -uo pipefail
title="$1"
shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  bash "$(dirname "${BASH_SOURCE[0]}")/ci-annotate.sh" "$log" "$title"
fi
rm -f "$log"
exit "$status"
