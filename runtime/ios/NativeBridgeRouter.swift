// bridgegen iOS 런타임. 생성 코드(BridgeContract.swift)와 같은 Swift Package 모듈에 들어간다.
//
//   let router = NativeBridgeRouter(handler: myHandler, policy: .init(allowedHosts: ["example.com"]))
//   router.attach(to: webView, appVersion: Bundle.main.appVersion)
//   router.send(.nativePing(.init(message: "hello", platform: .ios)))
//
// 맡는 일: origin 검사 → BridgeMessageProcessor(envelope · version · 화이트리스트 · params) → 응답 전달
//   1. 메시지마다 frameInfo를 검사한다 (진입 URL 한 번이 아니라). main frame + https + allowlist host.
//      허용되지 않은 origin · iframe은 응답하지 않고 버린다. 응답할 곳을 믿을 수 없어서다. Web은 TIMEOUT까지 기다린다.
//   2. 응답 · 이벤트를 보내기 직전에도 현재 문서의 origin을 다시 확인한다 (비동기 처리 중 페이지 이동 대비).
//   3. 지원 범위(window.__bridgeCapabilities)는 attach() 때 main frame 문서 시작 스크립트로 주입한다.
import Foundation
import WebKit

@MainActor
public final class NativeBridgeRouter: NSObject {
    public static let handlerName = "bridge"

    public struct Policy: Sendable {
        /// 허용 도메인. "example.com"은 그 도메인과 모든 하위 도메인을 허용한다.
        public var allowedHosts: Set<String>
        /// 개발용 http 허용 (예: localhost). 운영 빌드에서는 비워 둔다.
        public var allowedInsecureHosts: Set<String>

        public init(allowedHosts: Set<String>, allowedInsecureHosts: Set<String> = []) {
            self.allowedHosts = allowedHosts
            self.allowedInsecureHosts = allowedInsecureHosts
        }

        public func allows(scheme: String?, host: String?) -> Bool {
            guard let host = host?.lowercased(), !host.isEmpty else { return false }
            let matches = { (domains: Set<String>) in
                domains.contains { host == $0 || host.hasSuffix("." + $0) }
            }
            switch scheme?.lowercased() {
            case "https": return matches(allowedHosts)
            case "http": return matches(allowedInsecureHosts)
            default: return false
            }
        }
    }

    private let handler: BridgeMethodHandling
    private let policy: Policy
    private weak var webView: WKWebView?
    /// 웹 런타임이 수신 준비(bridge.hello)를 마쳤는지. 새 문서로 이동하면 다시 false가 된다.
    private var webReady = false
    /// hello 전에 보낸 이벤트. hello를 받으면 순서대로 보낸다.
    private var pending: [Data] = []
    /// hello 전에 쌓아 둘 수 있는 이벤트 수. 넘치면 오래된 것부터 버린다.
    public static let maxPending = 32
    /// 거부 · 오류 로그 (name, reason). id · method · 코드만 담고 payload는 담지 않는다.
    public var onLog: ((_ name: String, _ reason: String) -> Void)?

    /// - Precondition: allowedHosts는 비어 있으면 안 된다. 기본값 없는 필수 인자다.
    public init(handler: BridgeMethodHandling, policy: Policy) {
        precondition(!policy.allowedHosts.isEmpty || !policy.allowedInsecureHosts.isEmpty, "허용 origin 목록이 비어 있음")
        self.handler = handler
        self.policy = policy
    }

    public func attach(to webView: WKWebView, appVersion: String) {
        self.webView = webView
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.handlerName)
        // WKUserContentController는 handler를 강하게 잡으므로 weak proxy로 순환 참조를 끊는다.
        controller.add(WeakMessageHandler(self), name: Self.handlerName)
        controller.addUserScript(WKUserScript(
            source: Self.capabilitiesScript(appVersion: appVersion),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        // 새 문서가 시작되면(문서 시작 스크립트가 bridge.documentStart를 보냄) hello가 올 때까지 이벤트를 쌓아 둔다.
        // URL 변경으로 판단하지 않는다. SPA의 pushState는 URL만 바뀌고 hello를 다시 보내지 않기 때문이다.
        webReady = false
    }

    public func detach() {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName)
        webView = nil
        webReady = false
        pending.removeAll()
    }

    /// 네이티브 → 웹 이벤트. 웹이 아직 수신 준비(hello)를 마치지 않았으면 쌓아 두었다가 hello를 받으면 보낸다.
    /// (WKWebView의 didFinish 시점에도 페이지의 모듈 스크립트가 아직 실행 전일 수 있다.)
    public func send(_ event: BridgeEvent) {
        let envelope: Data
        do {
            envelope = try event.envelopeJSON()
        } catch {
            onLog?(event.name, "이벤트 인코딩 실패: \(error)")
            return
        }
        guard webReady else {
            if pending.count >= Self.maxPending {
                pending.removeFirst()
                onLog?(event.name, "대기 이벤트가 \(Self.maxPending)개를 넘어 가장 오래된 것을 버림")
            }
            pending.append(envelope)
            return
        }
        deliver(envelope)
    }

    /// 런타임 예약 이벤트 { type: event, source: web, event: bridge.hello | bridge.documentStart } 이면 그 이름
    private static func reservedEvent(_ body: Any) -> String? {
        let dict: [String: Any]?
        if let d = body as? [String: Any] { dict = d }
        else if let s = body as? String, s.utf8.count < 256, let data = s.data(using: .utf8) {
            dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        } else { dict = nil }
        guard dict?["type"] as? String == "event", dict?["source"] as? String == "web", let name = dict?["event"] as? String,
              name == "bridge.hello" || name == "bridge.documentStart" else { return nil }
        return name
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame else {
            onLog?("?", "sub frame 메시지 · 버림: \(origin.host)")
            return
        }
        guard policy.allows(scheme: origin.protocol, host: origin.host) else {
            onLog?("?", "허용되지 않은 origin · 버림: \(origin.protocol)://\(origin.host)")
            return
        }
        let body = message.body
        switch Self.reservedEvent(body) {
        case "bridge.documentStart":
            webReady = false
            return
        case "bridge.hello":
            webReady = true
            let queued = pending
            pending.removeAll()
            for envelope in queued { deliver(envelope) }
            return
        default:
            break
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let response = await BridgeMessageProcessor.handle(messageBody: body, handler: self.handler, onLog: self.onLog) {
                self.deliver(response)
            }
        }
    }

    private func deliver(_ envelope: Data) {
        guard let webView else { return }
        // 처리 도중 다른 origin으로 이동했을 수 있으므로 보내기 직전에 다시 확인
        guard policy.allows(scheme: webView.url?.scheme, host: webView.url?.host) else {
            onLog?("?", "현재 문서 origin이 허용 목록이 아니어서 전송 생략")
            return
        }
        // 문자열 조합 대신 arguments로 넘겨 JS 주입을 원천 차단한다.
        webView.callAsyncJavaScript(
            "window.__receiveBridgeMessage && window.__receiveBridgeMessage(m)",
            arguments: ["m": String(decoding: envelope, as: UTF8.self)],
            in: nil,
            in: .page,
            completionHandler: nil
        )
    }

    static func capabilitiesScript(appVersion: String) -> String {
        let caps: [String: Any] = [
            "version": bridgeEnvelopeVersion,
            "methods": BridgeMessageProcessor.methods,
            "events": BridgeMessageProcessor.events,
            "platform": "ios",
            "appVersion": appVersion,
            "contractVersion": bridgeContractVersion,
        ]
        // sortedKeys: 키 순서를 고정해야 같은 빌드가 매번 같은 스크립트를 넣는다
        let json = (try? JSONSerialization.data(withJSONObject: caps, options: [.sortedKeys]))
            .map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        return """
        (function () {
          try { window.webkit.messageHandlers.\(handlerName).postMessage({ type: 'event', version: 1, source: 'web', target: 'native', event: 'bridge.documentStart' }); } catch (e) {}
          if (window.__bridgeCapabilities) return;
          var caps = \(json);
          Object.freeze(caps.methods); Object.freeze(caps.events);
          Object.defineProperty(window, '__bridgeCapabilities', { value: Object.freeze(caps), writable: false, configurable: false });
        })();
        """
    }
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var router: NativeBridgeRouter?
    init(_ router: NativeBridgeRouter) { self.router = router }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { router?.receive(message) }
    }
}
