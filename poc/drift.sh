#!/usr/bin/env bash
# 계약이 바뀌면 앱이 컴파일 단계에서 깨지는지 증명한다.
#   examples/ping/asyncapi.yaml 에 REQUEST getPingCount 를 추가한 사본(v1.1.0)으로 패키지를 다시 만들고,
#   구현을 추가하지 않은 PoC 앱(iOS · Android)이 "구현 누락"으로 컴파일에 실패하는지 확인한다.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
d="$root/poc/out/drift"; mkdir -p "$d"
cd "$root"
node - "$d/asyncapi.yaml" <<'JS'
const fs = require('fs'); const { parse, stringify } = require('yaml')
const doc = parse(fs.readFileSync('examples/ping/asyncapi.yaml', 'utf8'))
doc.info.version = '1.1.0'
doc.channels.getPingCount = { address: 'getPingCount', messages: { request: { $ref: '#/components/messages/getPingCount.request' } } }
doc.channels.receiveBridgeMessage.messages['getPingCount.response'] = { $ref: '#/components/messages/getPingCount.response' }
doc.operations.getPingCount = {
  action: 'send', summary: '지금까지 받은 ping 횟수를 읽는다.', 'x-kind': 'request', 'x-since': { ios: '3.4.0', android: '3.4.0' }, 'x-idempotent': true,
  channel: { $ref: '#/channels/getPingCount' }, messages: [{ $ref: '#/channels/getPingCount/messages/request' }],
  reply: { channel: { $ref: '#/channels/receiveBridgeMessage' }, messages: [{ $ref: '#/channels/receiveBridgeMessage/messages/getPingCount.response' }] },
}
doc.components.messages['getPingCount.request'] = { name: 'getPingCount.request', payload: { $ref: '#/components/schemas/EmptyPayload' } }
doc.components.messages['getPingCount.response'] = { name: 'getPingCount.response', payload: { $ref: '#/components/schemas/PingCount' } }
doc.components.schemas.PingCount = { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } }
fs.writeFileSync(process.argv[2], stringify(doc))
JS
node src/cli.mjs build "$d/asyncapi.yaml" --out "$d/out" --targets ios,android >/dev/null || { echo "✖ drift spec build 실패"; exit 1; }
echo "· 계약 v1.1.0 (getPingCount 추가) 패키지 생성 완료"

ok=0
# iOS: 앱 코드(App.swift)를 바뀐 Swift Package 소스와 함께 iOS 시뮬레이터 SDK로 타입 검사
sed '/^import PingBridge$/d' poc/ios/PingPoC/App.swift > "$d/App.swift"
if xcrun --sdk iphonesimulator swiftc -typecheck -target arm64-apple-ios15.0-simulator \
    "$d"/out/ios/Sources/PingBridge/*.swift "$d/App.swift" > "$d/ios.log" 2>&1; then
  echo "✖ iOS: 구현이 없는데도 컴파일됨"
else
  grep -m1 "does not conform to protocol 'BridgeMethodHandling'" "$d/ios.log" >/dev/null \
    && { echo "✓ iOS: 컴파일 실패 — $(grep -m1 'does not conform' "$d/ios.log" | sed 's/.*error: //')"; grep -m1 "getPingCount" "$d/ios.log" | sed 's/^.*note: /    note: /'; ok=$((ok+1)); } \
    || { echo "✖ iOS: 예상과 다른 오류"; tail -5 "$d/ios.log"; }
fi

# Android: 같은 앱을 v1.1.0 아티팩트로 컴파일
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
if (cd poc/android && ./gradlew --no-daemon -q :app:compileDebugKotlin -Pbridgegen.repo="$d/out/maven" -Pbridgegen.version=1.1.0 > "$d/android.log" 2>&1); then
  echo "✖ Android: 구현이 없는데도 컴파일됨"
else
  grep -q "does not implement abstract member" "$d/android.log" && grep -q "getPingCount" "$d/android.log" \
    && { echo "✓ Android: 컴파일 실패 — $(grep -m1 'is not abstract' "$d/android.log" | sed 's/^e: [^ ]* //') $(grep -m1 'getPingCount' "$d/android.log" | sed 's/^ *//')"; ok=$((ok+1)); } \
    || { echo "✖ Android: 예상과 다른 오류"; tail -5 "$d/android.log"; }
fi
[ "$ok" = 2 ] && echo "✓ 계약 변경이 두 앱에서 모두 컴파일 오류로 드러남" || exit 1
