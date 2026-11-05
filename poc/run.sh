#!/usr/bin/env bash
# bridgegen PoC — 딸깍 한 번으로:
#   1. examples/ping/asyncapi.yaml → npm(tgz) · Swift Package · Maven(AAR) · 문서 생성
#   2. poc/web (React + Vite) 이 npm 패키지를 설치 · 빌드하고 :8787 로 서빙
#   3. iOS 앱이 Swift Package를, Android 앱이 Maven 아티팩트를 받아 빌드 · 실행
#   4. 두 앱의 WebView가 REQUEST · SEND · RECEIVE를 실제로 주고받고 PASS/FAIL을 보고 → poc/out/REPORT.md
#
#   bash poc/run.sh            # 전부
#   POC_SKIP_IOS=1 bash poc/run.sh / POC_SKIP_ANDROID=1 bash poc/run.sh
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/poc/out"; mkdir -p "$out"
started=$(date +%s)
cd "$root"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

step "1/4 bridgegen build"
node src/cli.mjs build examples/ping/asyncapi.yaml --out examples/ping/out --verify-ios || exit 1

step "2/4 React 웹 앱에 npm 패키지 설치 · 빌드 + 서빙 (:8787)"
node -e "require('fs').rmSync('poc/web/node_modules',{recursive:true,force:true})"
(cd poc/web && npm install --no-package-lock --silent && npm run build --silent) || exit 1
if ! curl -sf -o /dev/null http://localhost:8787/index.html; then
  python3 -m http.server 8787 --bind 0.0.0.0 --directory poc/web/dist > "$out/server.log" 2>&1 &
  server=$!
  trap 'kill $server 2>/dev/null' EXIT
  for _ in $(seq 1 20); do curl -sf -o /dev/null http://localhost:8787/index.html && break; sleep 0.5; done
fi

ios="skipped"; android="skipped"
if [ -z "${POC_SKIP_IOS:-}" ]; then
  step "3/4 iOS (Swift Package → 시뮬레이터)"
  if bash poc/ios/run.sh; then ios="PASS"; else ios="FAIL"; fi
fi
if [ -z "${POC_SKIP_ANDROID:-}" ]; then
  step "4/4 Android (Maven → 에뮬레이터)"
  if bash poc/android/run.sh; then android="PASS"; else android="FAIL"; fi
fi

node - "$out" "$ios" "$android" "$(( $(date +%s) - started ))" <<'JS'
const fs = require('fs'); const path = require('path')
const [out, ios, android, secs] = process.argv.slice(2)
const parse = (file) => {
  try {
    const line = fs.readFileSync(path.join(out, file), 'utf8').split('\n').find((l) => l.includes('RESULT '))
    // iOS: RESULT PASS 6/6 {...}  ·  Android(evaluateJavascript): RESULT PASS 6/6 "{\"pass\":...}"
    const rest = line.slice(line.indexOf('RESULT ')).replace(/^RESULT \S+ \S+ /, '')
    return JSON.parse(rest.startsWith('"') ? JSON.parse(rest) : rest)
  } catch { return null }
}
const rows = (r) => r ? r.results.map((x) => `| ${x.ok ? '✅' : '❌'} | ${x.badge} | ${x.name} | \`${JSON.stringify(x.detail).slice(0, 90)}\` |`).join('\n') : '| | | 결과 없음 | |'
const ir = parse('ios-console.log'); const ar = parse('android-logcat.log')
const md = `# bridgegen PoC 결과

- 실행: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (${secs}초)
- 입력: \`examples/ping/asyncapi.yaml\` 하나
- **iOS: ${ios}** · **Android: ${android}**

| 산출물 | 소비 방법 |
| --- | --- |
| \`examples/ping/out/example-ping-bridge-1.0.0.tgz\` | poc/web (React) 이 \`npm install\` (package.json \`file:\` 의존성) 후 Vite 빌드 |
| \`examples/ping/out/ios\` (Swift Package \`PingBridge\`) | poc/ios 앱이 SPM 로컬 패키지로 추가 (project.yml) |
| \`examples/ping/out/maven\` (\`com.example:ping-bridge:1.0.0\` AAR + POM) | poc/android 앱이 \`implementation("com.example:ping-bridge:1.0.0")\` |

## iOS (시뮬레이터)
| | 종류 | 검사 | 받은 값 |
| --- | --- | --- | --- |
${rows(ir)}

![iOS](ios-screenshot.png)

## Android (에뮬레이터)
| | 종류 | 검사 | 받은 값 |
| --- | --- | --- | --- |
${rows(ar)}

![Android](android-screenshot.png)
`
fs.writeFileSync(path.join(out, 'REPORT.md'), md)
console.log(`\n✓ poc/out/REPORT.md  (iOS ${ios} · Android ${android}, ${secs}s)`)
JS
[ "$ios" != "FAIL" ] && [ "$android" != "FAIL" ]
