#!/usr/bin/env bash
# Kotlin conformance 테스트용 툴체인을 받는다 (시스템 설치 없음). Android 앱과 같은 버전으로 맞춘다.
#   eval "$(scripts/fetch-kotlin-toolchain.sh .toolchain)"   → KOTLIN_HOME, BRIDGE_KT_JARS export
set -euo pipefail
dir="$(mkdir -p "${1:-.toolchain}" && cd "${1:-.toolchain}" && pwd)"
KOTLIN=2.1.20
SERIALIZATION=1.6.3
COROUTINES=1.8.1
M=https://repo1.maven.org/maven2/org/jetbrains/kotlinx

if [[ ! -x "$dir/kotlinc/bin/kotlinc" ]]; then
  curl -sSfL -o "$dir/kotlinc.zip" "https://github.com/JetBrains/kotlin/releases/download/v$KOTLIN/kotlin-compiler-$KOTLIN.zip"
  unzip -q -o "$dir/kotlinc.zip" -d "$dir" && rm "$dir/kotlinc.zip"
fi
mkdir -p "$dir/jars"
fetch() { [[ -f "$dir/jars/$2" ]] || curl -sSfL -o "$dir/jars/$2" "$1"; }
fetch "$M/kotlinx-serialization-core-jvm/$SERIALIZATION/kotlinx-serialization-core-jvm-$SERIALIZATION.jar" ser-core.jar
fetch "$M/kotlinx-serialization-json-jvm/$SERIALIZATION/kotlinx-serialization-json-jvm-$SERIALIZATION.jar" ser-json.jar
fetch "$M/kotlinx-coroutines-core-jvm/$COROUTINES/kotlinx-coroutines-core-jvm-$COROUTINES.jar" coroutines.jar

echo "export KOTLIN_HOME='$dir/kotlinc' BRIDGE_KT_JARS='$dir/jars'"
