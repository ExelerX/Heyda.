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
# GitHub cuts an annotation after about 4 KB, so long text goes out in several of them.
annotate() { # <title> ; text on stdin
  local chunk="" line n=0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line:0:300}"
    if [ $(( ${#chunk} + ${#line} )) -gt 3500 ]; then
      emit "$1" "$chunk"; chunk=""; n=$((n + 1))
      [ "$n" -ge 4 ] && return
    fi
    chunk+="$line"$'\n'
  done
  [ -n "$chunk" ] && emit "$1" "$chunk"
}
# Workflow commands need %, CR and LF escaped to keep a multi-line message in one annotation.
emit() { printf '::error title=%s::%s\n' "$1" "$(printf '%s' "$2" | tr -d '\r' | sed -e 's/%/%25/g' | awk 'BEGIN { ORS = "%0A" } { print }')"; }
# Compiler, TypeScript, npm, Gradle, test and xcodebuild failures; not command lines or file names.
pattern='(^|[^A-Za-z_-])((fatal )?error|Error)(:| TS[0-9]+)|npm (ERR!|error)|^FAILURE:|What went wrong|BUILD FAILED|failed with exit code|Exception:|^ *(FAIL|✗|×) '
grep -E "$pattern" "$log" | grep -vE '^\s*(/[^ ]*/)?(clang|swift-frontend|ld|libtool)\b|^\s*-' | awk '!seen[$0]++' | tail -n 40 | annotate "$title (errors)"
# xcodebuild lists the failed commands at the very end.
awk '/The following build commands failed:/ { on = 1 } on { print }' "$log" | head -n 15 | annotate "$title (failed commands)"
tail -n 25 "$log" | annotate "$title (last lines)"
