// bridgegen PoC (iOS): 생성된 Swift Package의 BridgeMethodHandling을 구현하고 NativeBridgeRouter로 WKWebView에 붙인다.
import SwiftUI
import WebKit
import PingBridge

/// 계약(asyncapi.yaml)이 요구하는 Handler. operation이 추가되면 여기서 컴파일 에러가 난다.
@MainActor
final class PocHandler: BridgeMethodHandling {
    private(set) var count = 0
    private(set) var log: [String] = []

    func ping(_ params: PingParams) async throws -> PongResult {
        if params.message == "reject" { throw BridgeFailure(.pingRejected, "rejected by PoC") }
        count += 1
        return PongResult(reply: "pong: \(params.message)", platform: .ios)
    }
    func resetPing() async throws { count = 0 }
    func logPing(_ params: PingParams) async throws {
        log.append(params.message)
        print("BRIDGEGEN_POC logPing:", params.message)
    }
    func clearPingLog() async throws { log.removeAll() }
}

@MainActor
final class WebController: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    let router: NativeBridgeRouter
    private var titleObservation: NSKeyValueObservation?

    override init() {
        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        router = NativeBridgeRouter(handler: PocHandler(), policy: .init(allowedHosts: ["example.com"], allowedInsecureHosts: ["localhost"]))
        super.init()
        router.onLog = { name, reason in print("BRIDGEGEN_POC router:", name, reason) }
        router.attach(to: webView, appVersion: "1.0.0")
        webView.navigationDelegate = self
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] web, _ in
            let title = web.title ?? ""
            guard title.hasPrefix("PASS") || title.hasPrefix("FAIL") else { return }
            Task { @MainActor in self?.report(title) }
        }
        let url = URL(string: (Bundle.main.object(forInfoDictionaryKey: "BRIDGEGEN_POC_URL") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "http://localhost:8787/index.html")!
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    // RECEIVE: 웹이 보낸 것의 응답이 아니라 Native가 먼저 알린다 (여기서는 페이지 로드가 끝난 뒤).
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 이 시점엔 페이지의 모듈 스크립트가 아직 실행 전일 수 있다. Router가 웹의 bridge.hello까지 쌓아 두었다가 보낸다.
        router.send(.nativePing(.init(message: "hello from iOS", platform: .ios)))
    }

    private func report(_ title: String) {
        webView.evaluateJavaScript("JSON.stringify(window.__pocResult)") { value, _ in
            print("BRIDGEGEN_POC RESULT \(title) \(value as? String ?? "")")
        }
    }
}

struct WebView: UIViewRepresentable {
    let controller: WebController
    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

@main
struct PingPoCApp: App {
    @StateObject private var controller = WebController()
    var body: some Scene {
        WindowGroup { WebView(controller: controller).ignoresSafeArea(edges: .bottom) }
    }
}
