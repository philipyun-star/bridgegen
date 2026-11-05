// bridgegen Android 런타임. 생성 코드(BridgeContract.kt)와 같은 라이브러리(AAR)에 들어간다.
//
//   val router = NativeBridgeRouter(
//       handler = myHandler,
//       scope = lifecycleScope,
//       allowedOriginRules = setOf("https://example.com", "https://*.example.com"),
//       appVersion = BuildConfig.VERSION_NAME,
//   )
//   router.attach(webView)
//   router.send(BridgeEvent.NativePing(NativePingPayload("hello", Platform.ANDROID)))
//
// 맡는 일: origin 검사 → BridgeMessageProcessor(envelope · version · 화이트리스트 · params) → 응답 전달
//   1. addJavascriptInterface 를 쓰지 않는다. (모든 frame·origin에 노출되고 호출자 origin을 알 수 없음)
//   2. addWebMessageListener 의 allowedOriginRules 로 WebView 자체가 origin을 걸러낸다.
//      허용되지 않은 origin 문서에는 window.bridge 객체 자체가 생기지 않는다.
//   3. 추가로 main frame 메시지만 처리한다. iframe 메시지는 응답 없이 버린다 (Web은 TIMEOUT까지 기다린다).
//   4. 이벤트는 마지막으로 hello를 보낸 main frame의 replyProxy로만 보낸다 (origin에 묶여 있음).
//   5. 지원 범위(window.__bridgeCapabilities)는 attach() 때 문서 시작 스크립트로 주입한다.
//      DOCUMENT_START_SCRIPT가 없는 WebView(예: 95)에서는 주입하지 못해 Web의 모든 요청이 UNSUPPORTED_VERSION이 된다.
package __PACKAGE__

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.WebView
import androidx.annotation.MainThread
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

public class NativeBridgeRouter(
    private val handler: BridgeMethodHandling,
    /** 보통 lifecycleScope. Main dispatcher 위에서 핸들러가 실행된다. */
    private val scope: CoroutineScope,
    // 예: "https://*.example.com" (KDoc 안에 쓰면 /* 가 중첩 주석으로 해석됨). 형식은 addWebMessageListener 문서 참고
    private val allowedOriginRules: Set<String>,
    private val appVersion: String,
    /** 거부 · 오류 로그. id · method · 코드만 담고 payload는 담지 않는다. */
    private val onLog: ((name: String, reason: String) -> Unit)? = null,
) {
    init {
        require(allowedOriginRules.isNotEmpty()) { "허용 origin 목록이 비어 있음" }
    }

    public companion object {
        public const val OBJECT_NAME: String = "bridge"
        /** 웹 런타임이 연결 직후 보내는 예약 이벤트. 계약 operation이 아니다. */
        internal const val HELLO: String = "bridge.hello"
        /** hello 전에 쌓아 둘 수 있는 이벤트 수 */
        public const val MAX_PENDING: Int = 32

        public fun isSupported(): Boolean =
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
    }

    private var eventProxy: JavaScriptReplyProxy? = null
    /** hello 전에 보낸 이벤트. 웹이 수신 준비를 마치면(hello) 순서대로 보낸다. */
    private val pending = ArrayDeque<String>()

    @MainThread
    @SuppressLint("RequiresFeature")
    public fun attach(webView: WebView) {
        check(isSupported()) { "WebView가 WEB_MESSAGE_LISTENER를 지원하지 않음 (WebView 업데이트 필요)" }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, capabilitiesScript(), allowedOriginRules)
        }

        WebViewCompat.addWebMessageListener(webView, OBJECT_NAME, allowedOriginRules) {
                _: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy ->
            if (!isMainFrame) {
                onLog?.invoke("?", "sub frame 메시지 · 버림: $sourceOrigin")
                return@addWebMessageListener
            }
            val data = message.data ?: return@addWebMessageListener
            if (isHello(data)) {
                eventProxy = replyProxy
                while (pending.isNotEmpty()) replyProxy.postMessage(pending.removeFirst())
                return@addWebMessageListener
            }
            scope.launch {
                val response = BridgeMessageProcessor.handle(data, handler, onLog) ?: return@launch
                replyProxy.postMessage(response)
            }
        }
    }

    @MainThread
    @SuppressLint("RequiresFeature")
    public fun detach(webView: WebView) {
        WebViewCompat.removeWebMessageListener(webView, OBJECT_NAME)
        eventProxy = null
        pending.clear()
    }

    /**
     * 네이티브 → 웹 이벤트. 웹이 아직 수신 준비(hello)를 마치지 않았으면 쌓아 두었다가 hello를 받으면 보낸다.
     * 쌓아 두는 개수는 [MAX_PENDING]까지이고, 넘치면 오래된 것부터 버린다.
     */
    @MainThread
    @SuppressLint("RequiresFeature")
    public fun send(event: BridgeEvent) {
        val json = event.toEnvelopeJson()
        val proxy = eventProxy
        if (proxy == null) {
            if (pending.size >= MAX_PENDING) {
                pending.removeFirst()
                onLog?.invoke(event.name, "대기 이벤트가 ${MAX_PENDING}개를 넘어 가장 오래된 것을 버림")
            }
            pending.addLast(json)
            return
        }
        proxy.postMessage(json)
    }

    private fun isHello(data: String): Boolean =
        data.length < 256 && runCatching {
            val o = JSONObject(data)
            o.optString("type") == "event" && o.optString("source") == "web" && o.optString("event") == HELLO
        }.getOrDefault(false)

    private fun capabilitiesScript(): String {
        val caps = JSONObject()
            .put("version", BRIDGE_ENVELOPE_VERSION)
            .put("methods", JSONArray(BridgeMessageProcessor.methods))
            .put("events", JSONArray(BridgeMessageProcessor.events))
            .put("platform", "android")
            .put("appVersion", appVersion)
            .put("contractVersion", BRIDGE_CONTRACT_VERSION)
        return """
            (function () {
              if (window.__bridgeCapabilities) return;
              var caps = $caps;
              Object.freeze(caps.methods); Object.freeze(caps.events);
              Object.defineProperty(window, '__bridgeCapabilities', { value: Object.freeze(caps), writable: false, configurable: false });
            })();
        """.trimIndent()
    }
}
