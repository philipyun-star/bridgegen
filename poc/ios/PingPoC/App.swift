// bridgegen PoC (iOS): 생성된 Swift Package의 BridgeMethodHandling을 구현하고 NativeBridgeRouter로 WKWebView에 붙인다.
// 화면: 위는 WebView(React 앱), 아래는 SwiftUI 네이티브 바 — 웹이 보낸 호출을 보여주고, RECEIVE 이벤트를 보내는 버튼이 있다.
import SwiftUI
import WebKit
import PingBridge

/// 계약(asyncapi.yaml)이 요구하는 Handler. operation이 추가되면 여기서 컴파일 에러가 난다.
@MainActor
final class PocHandler: BridgeMethodHandling {
    private(set) var count = 0
    private(set) var log: [String] = []
    /// 웹에서 호출이 들어올 때마다 네이티브 화면에 표시
    var onCall: (String) -> Void = { _ in }

    func ping(_ params: PingParams) async throws -> PongResult {
        if params.message == "reject" {
            onCall("REQUEST ping(\"reject\") → throw PING_REJECTED")
            throw BridgeFailure(.pingRejected, "rejected by PoC")
        }
        count += 1
        onCall("REQUEST ping(\"\(params.message)\") → return pong (count \(count))")
        return PongResult(reply: "pong: \(params.message)", platform: .ios)
    }
    func resetPing() async throws {
        count = 0
        onCall("REQUEST resetPing() → count 0")
    }
    func logPing(_ params: PingParams) async throws {
        log.append(params.message)
        onCall("SEND logPing(\"\(params.message)\") · 쌓인 로그 \(log.count)개")
        print("BRIDGEGEN_POC logPing:", params.message)
    }
    func clearPingLog() async throws {
        log.removeAll()
        onCall("SEND clearPingLog() · 쌓인 로그 0개")
    }
}

@MainActor
final class WebController: NSObject, ObservableObject, WKNavigationDelegate {
    let webView: WKWebView
    let router: NativeBridgeRouter
    @Published var lastCall = "아직 웹에서 받은 호출 없음"
    @Published var calls = 0
    private var pingSeq = 0
    private var titleObservation: NSKeyValueObservation?

    override init() {
        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let handler = PocHandler()
        router = NativeBridgeRouter(handler: handler, policy: .init(allowedHosts: ["example.com"], allowedInsecureHosts: ["localhost"]))
        super.init()
        handler.onCall = { [weak self] text in
            self?.lastCall = text
            self?.calls += 1
        }
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

    // RECEIVE: 웹이 보낸 것의 응답이 아니라 Native가 먼저 알린다 (페이지 로드 직후 한 번 — 자동 검사용).
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 이 시점엔 페이지의 모듈 스크립트가 아직 실행 전일 수 있다. Router가 웹의 bridge.hello까지 쌓아 두었다가 보낸다.
        router.send(.nativePing(.init(message: "hello from iOS", platform: .ios)))
    }

    // 네이티브 버튼 → RECEIVE 이벤트
    func sendNativePing() {
        pingSeq += 1
        router.send(.nativePing(.init(message: "iOS 버튼 #\(pingSeq)", platform: .ios)))
    }
    func sendNativePingStopped() { router.send(.nativePingStopped) }
    func reload() { webView.reload() }

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

/// 웹 밖의 진짜 네이티브 UI (SwiftUI)
struct NativeBar: View {
    @ObservedObject var controller: WebController
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("NATIVE · SwiftUI").font(.caption2.bold()).foregroundColor(.secondary)
                Spacer()
                Text("웹 호출 \(controller.calls)회").font(.caption2).foregroundColor(.secondary)
            }
            Text(controller.lastCall)
                .font(.system(.footnote, design: .monospaced))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Button("nativePing 보내기") { controller.sendNativePing() }.buttonStyle(.borderedProminent)
                Button("nativePingStopped") { controller.sendNativePingStopped() }.buttonStyle(.bordered)
                Spacer()
                Button { controller.reload() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.bordered)
            }
            .font(.footnote.bold())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemBackground))
    }
}

@main
struct PingPoCApp: App {
    @StateObject private var controller = WebController()
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 0) {
                WebView(controller: controller)
                Divider()
                NativeBar(controller: controller)
            }
        }
    }
}
