#!/usr/bin/env bash
# Android PoC: 로컬 Maven 저장소의 com.example:ping-bridge 로 앱을 빌드해 에뮬레이터에서 실행하고, 웹 페이지의 PASS/FAIL을 읽는다.
# 필요: Android SDK, JDK 17+, poc/web 을 :8787 로 서빙 중 (에뮬레이터에서는 http://10.0.2.2:8787)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../out"; mkdir -p "$out"
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
adb="$sdk/platform-tools/adb"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
cd "$here"
printf "sdk.dir=%s\n" "$sdk" > local.properties
./gradlew --no-daemon -q :app:assembleDebug --refresh-dependencies

if ! "$adb" get-state >/dev/null 2>&1; then
  avd="${POC_AVD:-$("$sdk/emulator/emulator" -list-avds | head -1)}"
  echo "· 에뮬레이터 시작: $avd"
  nohup "$sdk/emulator/emulator" -avd "$avd" -no-window -no-audio -no-boot-anim -no-snapshot-save -gpu swiftshader_indirect > "$out/emulator.log" 2>&1 &
fi
"$adb" wait-for-device
for _ in $(seq 1 120); do [ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 2; done

"$adb" install -r app/build/outputs/apk/debug/app-debug.apk >/dev/null
"$adb" shell am force-stop com.example.bridgegen.pingpoc
"$adb" logcat -c
"$adb" shell am start -n com.example.bridgegen.pingpoc/.MainActivity >/dev/null
for _ in $(seq 1 60); do "$adb" logcat -d -s BRIDGEGEN_POC:I | grep -q RESULT && break; sleep 1; done
sleep 1
"$adb" exec-out screencap -p > "$out/android-screenshot.png" || true
"$adb" logcat -d -s BRIDGEGEN_POC:I > "$out/android-logcat.log"
grep "BRIDGEGEN_POC" "$out/android-logcat.log" | cut -c1-200 || { echo "✖ Android: 결과를 받지 못함"; exit 1; }
grep -q "RESULT PASS" "$out/android-logcat.log" && echo "✓ Android PoC PASS" || { echo "✖ Android PoC FAIL"; exit 1; }
