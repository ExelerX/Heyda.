#!/usr/bin/env bash
# Installs the simulator build on a booted iPhone simulator, starts it and checks that it
# stays up and logs no crash or fatal JavaScript error.
#   bash scripts/ios-smoke.sh <path/to/Heyda.app> <output-folder>
set -uo pipefail
APP="$1"
OUT="$2"
BUNDLE=io.github.exelerx.heyda
mkdir -p "$OUT"

UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
for runtime in sorted(devices, reverse=True):
    if "iOS" not in runtime:
        continue
    for d in devices[runtime]:
        if d["name"].startswith("iPhone"):
            print(d["udid"]); sys.exit(0)
sys.exit(1)')" || { echo "::error::No iPhone simulator available."; exit 1; }
echo "Simulator $UDID"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP" || exit 1
START="$(date '+%Y-%m-%d %H:%M:%S')"
xcrun simctl launch "$UDID" "$BUNDLE" || exit 1
sleep 40
xcrun simctl io "$UDID" screenshot "$OUT/start.png" || true
xcrun simctl openurl "$UDID" "heyda://activity" || true
sleep 10
xcrun simctl io "$UDID" screenshot "$OUT/deeplink.png" || true

xcrun simctl spawn "$UDID" log show --start "$START" --style compact --predicate 'process == "Heyda"' > "$OUT/log.txt" 2>&1 || true
fail=0
if ! xcrun simctl spawn "$UDID" launchctl list | grep -q "$BUNDLE"; then
  echo "::error::The app is not running anymore."
  fail=1
fi
if grep -nE "RCTFatal|Unhandled JS Exception|Terminating app due to uncaught exception" "$OUT/log.txt"; then
  echo "::error::The app crashed (see log above)."
  fail=1
fi
[ "$fail" = 0 ] && echo "iOS smoke test passed."
exit "$fail"
