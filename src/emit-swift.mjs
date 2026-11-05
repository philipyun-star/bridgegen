import { HEADER, docLines, lowerCamel, SWIFT_KEYWORDS } from './util.mjs'
import { isEmpty } from './model.mjs'

const ident = (s) => (SWIFT_KEYWORDS.has(s) ? `\`${s}\`` : s)

function swiftType(ty) {
  switch (ty.t) {
    case 'ref':
      return ty.name
    case 'string':
      return 'String'
    case 'boolean':
      return 'Bool'
    case 'integer':
      return 'Int'
    case 'number':
      return 'Double'
    case 'array':
      return `[${swiftType(ty.items)}]`
  }
}

const doc = (text, indent = '') =>
  docLines(text)
    .map((l) => `${indent}/// ${l}\n`)
    .join('')

export function emitSwift(model) {
  const acc = model.codegen.swiftAccessLevel ?? 'public'
  const A = acc === 'internal' ? '' : `${acc} `
  const ops = model.operations
  const byKind = (k) => ops.filter((o) => o.kind === k)
  const requests = byKind('request')
  const emits = byKind('emit')
  const events = byKind('event')

  let out = `${HEADER('//')}\n// swiftlint:disable all\nimport Foundation\n\n`
  out += `${A}let bridgeContractVersion = "${model.version}"\n`
  out += `/// envelope 형식 버전. 라이브러리 런타임이 소유하며 계약 버전과 따로 센다.\n${A}let bridgeEnvelopeVersion = 1\n\n`

  // ── types ──
  for (const t of model.types) {
    out += doc(t.description)
    if (t.kind === 'enum') {
      out += `${A}enum ${t.name}: String, Codable, Sendable, CaseIterable {\n`
      for (const v of t.values) out += `    case ${ident(lowerCamel(v))} = "${v}"\n`
      out += `}\n\n`
      continue
    }
    out += `${A}struct ${t.name}: Codable, Equatable, Sendable {\n`
    for (const f of t.fields) {
      out += doc(f.description, '    ')
      out += `    ${A}var ${ident(f.name)}: ${swiftType(f.type)}${f.required ? '' : '?'}\n`
    }
    const params = t.fields.map((f) => `${ident(f.name)}: ${swiftType(f.type)}${f.required ? '' : '? = nil'}`).join(', ')
    out += `\n    ${A}init(${params}) {\n`
    for (const f of t.fields) out += `        self.${f.name} = ${ident(f.name)}\n`
    out += `    }\n}\n\n`
  }

  // ── handler가 던지는 오류 ──
  out += `/// Handler가 던지면 \`NATIVE_ERROR\` + \`details.code\` 로 웹에 전달된다.
${A}struct BridgeFailure: Error, Equatable, Sendable {
    ${A}let code: NativeErrorCode
    ${A}let message: String
    ${A}let retryable: Bool
    ${A}init(_ code: NativeErrorCode, _ message: String, retryable: Bool = false) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }
}

`

  // ── registry (화이트리스트) ──
  out += `/// bridge.request로 부를 수 있는 method (화이트리스트)\n${A}enum BridgeMethod: String, CaseIterable, Sendable {\n`
  for (const o of requests) out += `    case ${o.camel} = "${o.name}"\n`
  out += `}\n\n/// bridge.emit으로 받을 수 있는 event (화이트리스트)\n${A}enum BridgeEmit: String, CaseIterable, Sendable {\n`
  for (const o of emits) out += `    case ${o.camel} = "${o.name}"\n`
  out += `}\n\n`

  // ── handler protocol ──
  out += `/// 계약의 method · emit을 처리한다. 앱의 Native Handler가 구현한다.
/// 계약에 operation이 추가되면 구현하지 않은 Handler는 컴파일되지 않는다.
@MainActor
${A}protocol BridgeMethodHandling: AnyObject {
`
  for (const o of requests) {
    out += doc(`[request] ${o.summary}`, '    ')
    const param = isEmpty(model, o.payload) ? '' : `_ params: ${o.payload}`
    const ret = !isEmpty(model, o.result) ? ` -> ${o.result}` : ''
    out += `    func ${o.camel}(${param}) async throws${ret}\n`
  }
  for (const o of emits) {
    out += doc(`[emit] ${o.summary}`, '    ')
    const param = isEmpty(model, o.payload) ? '' : `_ params: ${o.payload}`
    out += `    func ${o.camel}(${param}) async throws\n`
  }
  out += `}\n\n`

  // ── Native → Web events ──
  out += `/// Native → Web 푸시 이벤트 (bridge.on)\n${A}enum BridgeEvent: Sendable {\n`
  for (const o of events) {
    out += doc(o.summary, '    ')
    out += isEmpty(model, o.payload) ? `    case ${o.camel}\n` : `    case ${o.camel}(${o.payload})\n`
  }
  out += `\n    ${A}var name: String {\n        switch self {\n`
  for (const o of events) out += `        case .${o.camel}: return "${o.name}"\n`
  out += `        }\n    }\n\n`
  out += `    /// \`window.__receiveBridgeMessage(...)\` 에 넘길 event envelope JSON\n`
  out += `    ${A}func envelopeJSON() throws -> Data {\n        switch self {\n`
  for (const o of events) {
    out += isEmpty(model, o.payload)
      ? `        case .${o.camel}: return try BridgeCoding.encode(OutgoingEvent(event: name, payload: EmptyPayload()))\n`
      : `        case .${o.camel}(let p): return try BridgeCoding.encode(OutgoingEvent(event: name, payload: p))\n`
  }
  out += `        }\n    }\n}\n\n`

  // ── processor ──
  out += `/// 수신 envelope을 검사하고 Handler로 나눈다. WebView를 모르므로 conformance 픽스처로 그대로 테스트한다.
///
/// 규칙 (fixtures/native/*.json 이 세 플랫폼에서 같은 결과를 내야 한다)
/// - JSON 객체가 아니거나 type을 모르면 버린다.
/// - rpc_request: id는 문자열, target은 "native". 아니면 응답할 곳을 믿을 수 없어 버린다.
///   version ≠ 1 → UNSUPPORTED_VERSION. 화이트리스트 밖 → NATIVE_ERROR(METHOD_NOT_ALLOWED).
///   params가 계약과 다름 → NATIVE_ERROR(INVALID_PARAMS). params가 없거나 null이면 빈 객체로 본다.
/// - event: source "web", target 없거나 "native", version 1, 화이트리스트 안, payload가 계약과 같을 때만 Handler를 부른다.
///   그 밖은 응답 없이 버린다.
${A}enum BridgeMessageProcessor {
    /// \`window.__bridgeCapabilities\` 주입에 쓰는 지원 범위
    ${A}static let methods: [String] = BridgeMethod.allCases.map(\\.rawValue)
    ${A}static let events: [String] = BridgeEmit.allCases.map(\\.rawValue)

    /// - Returns: 웹에 돌려줄 rpc_response JSON. 응답하지 않을 때는 nil.
    @MainActor
    ${A}static func handle(
        _ body: Data,
        handler: BridgeMethodHandling,
        onLog: ((_ name: String, _ reason: String) -> Void)? = nil
    ) async -> Data? {
        guard let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let type = obj["type"] as? String
        else {
            onLog?("?", "envelope 형식 아님 · 버림")
            return nil
        }
        let version = BridgeCoding.integer(obj["version"])

        switch type {
        case "rpc_request":
            guard let id = obj["id"] as? String, obj["target"] as? String == "native", let method = obj["method"] as? String else {
                onLog?("?", "rpc_request 필수 필드(id 문자열, target native, method) 오류 · 버림")
                return nil
            }
            func fail(_ code: BridgeErrorCode, _ message: String, details: NativeErrorCode? = nil, retryable: Bool = false) -> Data? {
                onLog?(method, "\\(details?.rawValue ?? code.rawValue): \\(message)")
                let error = BridgeError(code: code, message: message, retryable: retryable, details: details.map { BridgeErrorDetails(code: $0) })
                return try? BridgeCoding.encode(OutgoingResponse<EmptyPayload>(id: id, method: method, result: nil, error: error))
            }
            func reply<R: Encodable>(_ result: R) -> Data? {
                do {
                    return try BridgeCoding.encode(OutgoingResponse(id: id, method: method, result: result, error: nil))
                } catch {
                    return fail(.nativeError, "응답 인코딩 실패", details: .internal)
                }
            }
            guard version == bridgeEnvelopeVersion else {
                return fail(.unsupportedVersion, "envelope version \\(String(describing: obj["version"] ?? "nil")) 미지원")
            }
            guard let m = BridgeMethod(rawValue: method) else {
                return fail(.nativeError, "화이트리스트에 없는 method", details: .methodNotAllowed)
            }
            do {
                switch m {
`
  for (const o of requests) {
    out += `                case .${o.camel}:\n`
    const call = isEmpty(model, o.payload) ? `handler.${o.camel}()` : `handler.${o.camel}(try BridgeCoding.decode(${o.payload}.self, obj["params"]))`
    out += isEmpty(model, o.result) ? `                    try await ${call}\n                    return reply(EmptyPayload())\n` : `                    return reply(try await ${call})\n`
  }
  out += `                }
            } catch let failure as BridgeFailure {
                return fail(.nativeError, failure.message, details: failure.code, retryable: failure.retryable)
            } catch is BridgeCoding.InvalidParams {
                return fail(.nativeError, "params가 계약과 다름", details: .invalidParams)
            } catch is DecodingError {
                return fail(.nativeError, "params가 계약과 다름", details: .invalidParams)
            } catch {
                return fail(.nativeError, String(describing: error), details: .internal)
            }

        case "event":
            guard version == bridgeEnvelopeVersion,
                  obj["source"] as? String == "web",
                  obj["target"] == nil || obj["target"] as? String == "native",
                  let name = obj["event"] as? String
            else {
                onLog?("?", "event 필수 필드(version 1, source web, event) 오류 · 버림")
                return nil
            }
            guard let e = BridgeEmit(rawValue: name) else {
                onLog?(name, "화이트리스트에 없는 event · 버림")
                return nil
            }
            do {
                switch e {
`
  for (const o of emits) {
    const call = isEmpty(model, o.payload) ? `handler.${o.camel}()` : `handler.${o.camel}(try BridgeCoding.decode(${o.payload}.self, obj["payload"]))`
    out += `                case .${o.camel}:\n                    try await ${call}\n`
  }
  out += `                }
            } catch is BridgeCoding.InvalidParams {
                onLog?(name, "payload가 계약과 다름 · 버림")
            } catch is DecodingError {
                onLog?(name, "payload가 계약과 다름 · 버림")
            } catch {
                onLog?(name, "Handler 오류: \\(error)")
            }
            return nil

        default:
            onLog?("?", "모르는 type \\(type) · 버림")
            return nil
        }
    }

    /// WKScriptMessage.body (NSDictionary/NSString) 를 그대로 받는 편의 함수
    @MainActor
    ${A}static func handle(
        messageBody: Any,
        handler: BridgeMethodHandling,
        onLog: ((_ name: String, _ reason: String) -> Void)? = nil
    ) async -> Data? {
        let data: Data?
        if let string = messageBody as? String {
            data = string.data(using: .utf8)
        } else if JSONSerialization.isValidJSONObject(messageBody) {
            data = try? JSONSerialization.data(withJSONObject: messageBody)
        } else {
            data = nil
        }
        guard let data else {
            onLog?("?", "body가 JSON이 아님 · 버림")
            return nil
        }
        return await handle(data, handler: handler, onLog: onLog)
    }
}

// MARK: - envelope coding (internal)

struct OutgoingResponse<R: Encodable>: Encodable {
    let type = "rpc_response"
    let id: String
    let version = bridgeEnvelopeVersion
    let source = "native"
    let method: String
    let result: R?
    let error: BridgeError?

    enum CodingKeys: String, CodingKey { case type, id, version, source, method, result, error }
}

struct OutgoingEvent<P: Encodable>: Encodable {
    let type = "event"
    let version = bridgeEnvelopeVersion
    let source = "native"
    let event: String
    let payload: P

    enum CodingKeys: String, CodingKey { case type, version, source, event, payload }
}

enum BridgeCoding {
    struct InvalidParams: Error {}

    static let decoder = JSONDecoder()
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()

    static func encode<T: Encodable>(_ value: T) throws -> Data { try encoder.encode(value) }

    /// params · payload 디코드. 없거나 null이면 빈 객체로 본다. 객체가 아니면 InvalidParams.
    static func decode<P: Decodable>(_ type: P.Type, _ value: Any?) throws -> P {
        let object: Any = (value == nil || value is NSNull) ? [String: Any]() : value!
        guard object is [String: Any] else { throw InvalidParams() }
        return try decoder.decode(P.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// JSON 정수만 받는다. 문자열 "1"이나 true는 정수가 아니다.
    static func integer(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d == d.rounded() ? n.intValue : nil
    }
}
`
  return out
}
