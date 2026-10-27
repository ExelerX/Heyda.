#!/usr/bin/env bash
# Repeats the important part of a build log as GitHub error annotations. Annotations can be read
# through the GitHub API and show up on the pull request; the full job logs live on separate
# storage that not every client can reach.
# Usage: bash scripts/ci-annotate.sh <log file> "<title>"
set -uo pipefail
log="$1"
title="${2:-Build}"
if [ ! -f "$log" ]; then
  echo "::error title=$title::Log $log not found"
  exit 0
fi
# Workflow commands need %, CR and LF escaped to keep a multi-line message in one annotation.
encode() { tr -d '\r' | cut -c1-400 | sed -e 's/%/%25/g' | awk 'BEGIN { ORS = "%0A" } { print }'; }
errors="$(grep -E '(error|Error|ERROR|FAILED|FAILURE|fatal|Exception)[: ]' "$log" | grep -v -i 'warning:' | tail -n 60)"
if [ -n "$errors" ]; then
  echo "::error title=$title (errors)::$(printf '%s\n' "$errors" | encode)"
fi
echo "::error title=$title (last lines)::$(tail -n 80 "$log" | encode)"
