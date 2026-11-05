#!/usr/bin/env bash
# 생성된 Swift 코드를 컴파일하고 conformance fixtures를 실행한다. (macOS, Xcode CLT 필요)
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/test/.gen/.ios-out"
mkdir -p "$out"
swiftc -swift-version 5 -strict-concurrency=complete -warnings-as-errors \
  -o "$out/conformance" \
  "$root/test/.gen/ios/Sources/PingBridge/BridgeContract.swift" "$root/test/ios/main.swift" 2>&1
"$out/conformance" "$root/test/fixtures"
