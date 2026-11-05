#!/usr/bin/env bash
# 생성된 Kotlin 코드를 컴파일하고 conformance fixtures를 실행한다.
# 필요: JDK 17+, 그리고 아래 환경변수 (없으면 test/android/fetch-kotlin-toolchain.sh 로 받는다)
#   KOTLIN_HOME     kotlinc 2.1.x 경로 (bin/kotlinc, lib/kotlinx-serialization-compiler-plugin.jar)
#   BRIDGE_KT_JARS  kotlinx-serialization-core/json-jvm 1.6.3 + kotlinx-coroutines-core-jvm jar 디렉터리
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
: "${KOTLIN_HOME:?KOTLIN_HOME 필요 (test/android/fetch-kotlin-toolchain.sh 참고)}"
: "${BRIDGE_KT_JARS:?BRIDGE_KT_JARS 필요}"
out="$root/test/.gen/.android-out"
mkdir -p "$out"
cp="$(ls "$BRIDGE_KT_JARS"/*.jar | tr '\n' ':')"
# shellcheck disable=SC2046
"$KOTLIN_HOME/bin/kotlinc" -Werror \
  -Xplugin="$KOTLIN_HOME/lib/kotlinx-serialization-compiler-plugin.jar" \
  -cp "$cp" -d "$out/conformance.jar" \
  "$root/test/.gen/android/src/main/kotlin/com/example/pingbridge/BridgeContract.kt" "$root/test/android/Conformance.kt"
java -cp "$out/conformance.jar:$cp:$KOTLIN_HOME/lib/kotlin-stdlib.jar" ConformanceKt "$root/test/fixtures"
