// bridgegen PoC (Android): Maven으로 받은 라이브러리의 BridgeMethodHandling을 구현하고 NativeBridgeRouter로 WebView에 붙인다.
package com.example.bridgegen.pingpoc

import android.os.Bundle
import android.util.Log
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.example.pingbridge.BridgeEvent
import com.example.pingbridge.BridgeFailure
import com.example.pingbridge.BridgeMethodHandling
import com.example.pingbridge.NativeBridgeRouter
import com.example.pingbridge.NativeErrorCode
import com.example.pingbridge.NativePingPayload
import com.example.pingbridge.PingParams
import com.example.pingbridge.Platform
import com.example.pingbridge.PongResult

private const val TAG = "BRIDGEGEN_POC"

/** 계약(asyncapi.yaml)이 요구하는 Handler. operation이 추가되면 여기서 컴파일 에러가 난다. */
class PocHandler : BridgeMethodHandling {
    private var count = 0
    private val log = mutableListOf<String>()

    override suspend fun ping(params: PingParams): PongResult {
        if (params.message == "reject") throw BridgeFailure(NativeErrorCode.PING_REJECTED, "rejected by PoC")
        count++
        return PongResult(reply = "pong: ${params.message}", platform = Platform.ANDROID)
    }
    override suspend fun resetPing() { count = 0 }
    override suspend fun logPing(params: PingParams) {
        log += params.message
        Log.i(TAG, "logPing: ${params.message}")
    }
    override suspend fun clearPingLog() { log.clear() }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra("url") ?: "http://10.0.2.2:8787/index.html"
        val origin = Regex("^(https?://[^/]+)").find(url)!!.value
        WebView.setWebContentsDebuggingEnabled(true)
        val webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
        setContentView(webView)

        val router = NativeBridgeRouter(
            handler = PocHandler(),
            scope = lifecycleScope,
            allowedOriginRules = setOf(origin),
            appVersion = "1.0.0",
            onLog = { name, reason -> Log.i(TAG, "router: $name $reason") },
        )
        router.attach(webView)

        webView.webViewClient = object : WebViewClient() {
            // RECEIVE: 웹이 보낸 것의 응답이 아니라 Native가 먼저 알린다 (여기서는 페이지 로드가 끝난 뒤).
            override fun onPageFinished(view: WebView, url: String) {
                router.send(BridgeEvent.NativePing(NativePingPayload(message = "hello from Android", platform = Platform.ANDROID)))
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String) {
                if (!title.startsWith("PASS") && !title.startsWith("FAIL")) return
                view.evaluateJavascript("JSON.stringify(window.__pocResult)") { json -> Log.i(TAG, "RESULT $title $json") }
            }
        }
        webView.loadUrl(url)
    }
}
