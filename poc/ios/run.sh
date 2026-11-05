#!/usr/bin/env bash
# iOS PoC: 생성된 Swift Package로 앱을 빌드해 시뮬레이터에서 실행하고, 웹 페이지의 PASS/FAIL을 읽는다.
# 필요: Xcode, xcodegen, poc/web 을 http://localhost:8787 로 서빙 중일 것 (poc/run.sh가 띄움)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../out"; mkdir -p "$out"
udid="${POC_IOS_UDID:-$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next(x["udid"] for k,v in d.items() if "iOS" in k for x in v if x["name"].startswith("iPhone")))')}"
cd "$here"
xcodegen generate -q
xcodebuild -project PingPoC.xcodeproj -scheme PingPoC -destination "id=$udid" -derivedDataPath "$out/ios-dd" -quiet build
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl install "$udid" "$out/ios-dd/Build/Products/Debug-iphonesimulator/PingPoC.app"
log="$out/ios-console.log"; : > "$log"
xcrun simctl launch --console-pty --terminate-running-process "$udid" com.example.bridgegen.PingPoC > "$log" 2>&1 &
pid=$!
for _ in $(seq 1 60); do grep -q "BRIDGEGEN_POC RESULT" "$log" && break; sleep 1; done
sleep 1
xcrun simctl io "$udid" screenshot "$out/ios-screenshot.png" >/dev/null 2>&1 || true
kill "$pid" 2>/dev/null || true
grep "BRIDGEGEN_POC" "$log" || { echo "✖ iOS: 결과를 받지 못함 (log: $log)"; exit 1; }
grep -q "BRIDGEGEN_POC RESULT PASS" "$log" && echo "✓ iOS PoC PASS" || { echo "✖ iOS PoC FAIL"; exit 1; }
