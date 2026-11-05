# Conformance fixtures

세 플랫폼이 **같은 입력에 같은 결과**를 내는지 확인하는 공용 테스트 데이터입니다.
envelope 검증 규칙은 TypeScript · Swift · Kotlin에 세 번 구현되므로, 한 구현만 규칙을 바꾸면 나머지 언어의 테스트가 실패합니다.

## native/*.json — Native Router가 Web 메시지를 받을 때
`BridgeMessageProcessor.handle(...)`에 넣는 입력과 기대 결과입니다.

| 필드 | 의미 |
|---|---|
| `input` / `inputRaw` | 웹이 보낸 envelope (`inputRaw`는 JSON이 아닌 원문) |
| `expect` | 돌려줄 `rpc_response`. `null`이면 응답하지 않음(버림) |
| `calls` | Handler가 호출되어야 하는 method · event 목록 |

`error.message`는 플랫폼마다 문구가 달라도 되므로 비교하지 않습니다. `code` · `retryable` · `details.code`는 비교합니다.

### 규칙
| 입력 | 결과 |
|---|---|
| JSON 객체가 아님 · 모르는 `type` | 버림 |
| `rpc_request`인데 `id`가 문자열이 아님 · `target`이 `native`가 아님 · `method` 없음 | 버림 (응답할 곳을 믿을 수 없음) |
| `version`이 정수 1이 아님 (`"1"` 포함) | `UNSUPPORTED_VERSION` |
| 화이트리스트 밖 `method` (emit 이름 포함) | `NATIVE_ERROR` + `METHOD_NOT_ALLOWED` |
| `params`가 계약과 다름 · 객체가 아님 | `NATIVE_ERROR` + `INVALID_PARAMS` |
| `params` 없음 · `null` | 빈 객체로 봄 |
| Handler가 `BridgeFailure(code)`를 던짐 | `NATIVE_ERROR` + `details.code = code` |
| `event`인데 `source`가 `web`이 아님 · version 1 아님 · 화이트리스트 밖 · payload가 계약과 다름 | 버림, Handler 미호출 |

### 테스트 Handler 규약 (각 플랫폼 테스트가 똑같이 구현)
- `ping` → `{ reply: "pong: " + message, platform: "ios" }`. `message`가 `reject`이면 `BridgeFailure(PING_REJECTED)`
- `resetPing` → `{}`
- emit(`logPing` · `clearPingLog`) → 호출만 기록

## events/*.json — Native → Web 이벤트 인코딩
`event` + `payload`로 만든 envelope이 `expect`와 같아야 합니다.
