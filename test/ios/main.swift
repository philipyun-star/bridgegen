// bridgegen이 만든 BridgeContract.swift + 이 파일을 swiftc로 함께 컴파일해 fixtures를 돌린다.
import Foundation

@MainActor
final class FixtureHandler: BridgeMethodHandling {
    var calls: [String] = []

    func ping(_ params: PingParams) async throws -> PongResult {
        calls.append("ping")
        if params.message == "reject" { throw BridgeFailure(.pingRejected, "ping rejected") }
        return PongResult(reply: "pong: \(params.message)", platform: .ios)
    }
    func resetPing() async throws {
        calls.append("resetPing")
    }
    func logPing(_ params: PingParams) async throws {
        calls.append("logPing")
    }
    func clearPingLog() async throws {
        calls.append("clearPingLog")
    }
}

/// error.message는 플랫폼별 문구라 비교에서 뺀다
func normalize(_ value: Any?) -> Any? {
    guard var dict = value as? [String: Any] else { return value }
    if var error = dict["error"] as? [String: Any] {
        error.removeValue(forKey: "message")
        dict["error"] = error
    }
    return dict
}

func equal(_ a: Any?, _ b: Any?) -> Bool {
    switch (a, b) {
    case (nil, nil): return true
    case let (a as NSObject, b as NSObject): return a.isEqual(b)
    default: return false
    }
}

@MainActor
func run() async -> Int32 {
    let dir = URL(fileURLWithPath: CommandLine.arguments[1])
    var failed = 0
    var total = 0

    let dispatchDir = dir.appendingPathComponent("native")
    for file in try! FileManager.default.contentsOfDirectory(atPath: dispatchDir.path).sorted() where file.hasSuffix(".json") {
        total += 1
        let fixture = try! JSONSerialization.jsonObject(with: Data(contentsOf: dispatchDir.appendingPathComponent(file))) as! [String: Any]
        let input: Data = if let raw = fixture["inputRaw"] as? String {
            Data(raw.utf8)
        } else {
            try! JSONSerialization.data(withJSONObject: fixture["input"]!)
        }
        let handler = FixtureHandler()
        let out = await BridgeMessageProcessor.handle(input, handler: handler)
        let actual = out.map { try! JSONSerialization.jsonObject(with: $0) }
        let expected = fixture["expect"] is NSNull ? nil : fixture["expect"]
        let expectedCalls = fixture["calls"] as! [String]

        var problems: [String] = []
        if !equal(normalize(actual), normalize(expected)) {
            problems.append("response\n      expected: \(String(describing: expected))\n      actual:   \(out.map { String(decoding: $0, as: UTF8.self) } ?? "nil")")
        }
        if let err = (actual as? [String: Any])?["error"] as? [String: Any], !(err["message"] is String) {
            problems.append("error.message가 문자열이 아님")
        }
        if handler.calls != expectedCalls {
            problems.append("calls expected \(expectedCalls) actual \(handler.calls)")
        }
        if problems.isEmpty {
            print("  ✓ native/\(file)")
        } else {
            failed += 1
            print("  ✖ native/\(file)\n    " + problems.joined(separator: "\n    "))
        }
    }

    let eventsDir = dir.appendingPathComponent("events")
    for file in try! FileManager.default.contentsOfDirectory(atPath: eventsDir.path).sorted() where file.hasSuffix(".json") {
        total += 1
        let fixture = try! JSONSerialization.jsonObject(with: Data(contentsOf: eventsDir.appendingPathComponent(file))) as! [String: Any]
        let payload = try! JSONSerialization.data(withJSONObject: fixture["payload"]!)
        let event: BridgeEvent
        switch fixture["event"] as! String {
        case "nativePing": event = .nativePing(try! JSONDecoder().decode(NativePingPayload.self, from: payload))
        case "nativePingStopped": event = .nativePingStopped
        case let other: fatalError("테스트에 이벤트 매핑 추가 필요: \(other)")
        }
        let actual = try! JSONSerialization.jsonObject(with: event.envelopeJSON())
        if equal(actual, fixture["expect"]) {
            print("  ✓ events/\(file)")
        } else {
            failed += 1
            print("  ✖ events/\(file)\n    actual: \(actual)")
        }
    }

    print(failed == 0 ? "iOS conformance: \(total)/\(total) 통과" : "iOS conformance: \(failed)/\(total) 실패")
    return failed == 0 ? 0 : 1
}

let code = await run()
exit(code)
