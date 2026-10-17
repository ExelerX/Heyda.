#!/usr/bin/env bash
# Installs the release APK on a running emulator, starts it and checks that it stays up,
# renders its UI and logs no crash or JavaScript error.
#   bash scripts/android-smoke.sh <folder-with-apk> <output-folder>
set -uo pipefail
APK_DIR="$1"
OUT="$2"
PKG=io.github.exelerx.heyda
mkdir -p "$OUT"

APK="$(ls "$APK_DIR"/*.apk | head -n 1)"
echo "Installing $APK"
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'
# -g grants the runtime permissions, so no system dialog covers the app.
adb install -r -g "$APK" || exit 1
adb logcat -c

shoot() {
  adb exec-out screencap -p > "$OUT/$1.png" 2>/dev/null || true
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb pull /sdcard/ui.xml "$OUT/$1.xml" >/dev/null 2>&1 || true
}

adb shell am start -W -n "$PKG/.MainActivity"
sleep 30
shoot start

# A cold start through a deep link (as a tapped notification would do).
adb shell am start -W -a android.intent.action.VIEW -d "heyda://activity" "$PKG" >/dev/null
sleep 10
shoot deeplink

# Background and foreground again, like switching apps.
adb shell input keyevent KEYCODE_HOME
sleep 5
adb shell am start -W -n "$PKG/.MainActivity" >/dev/null
sleep 10
shoot resumed

adb logcat -d -v brief > "$OUT/logcat.txt"
fail=0
if [ -z "$(adb shell pidof "$PKG" | tr -d '\r')" ]; then
  echo "::error::The app is not running anymore."
  fail=1
fi
if grep -nE "FATAL EXCEPTION|ANR in $PKG" "$OUT/logcat.txt"; then
  echo "::error::The app crashed or froze (see logcat above)."
  fail=1
fi
# Errors from JavaScript. Relay connection problems are the network, not the app.
if grep -nE "^E/ReactNativeJS" "$OUT/logcat.txt" | grep -viE "websocket|relay|network request failed"; then
  echo "::error::JavaScript errors in the log (see above)."
  fail=1
fi
# Visible text only: every node of the dump carries package="io.github.exelerx.heyda", so matching
# anywhere would pass on a blank screen or a stuck splash too.
if [ ! -s "$OUT/start.xml" ]; then
  echo "::error::No UI dump of the start screen."
  fail=1
elif ! grep -qE '(text|content-desc)="[^"]*(Heyda|ankommst)' "$OUT/start.xml"; then
  echo "::error::The start screen did not render the expected text."
  fail=1
fi
if grep -qE '(text|content-desc)="[^"]*Kurz hängen geblieben' "$OUT"/*.xml 2>/dev/null; then
  echo "::error::The app shows its error screen."
  fail=1
fi
[ "$fail" = 0 ] && echo "Android smoke test passed."
exit "$fail"
