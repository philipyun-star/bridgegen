// bridgegen PoC (Android): Maven으로 받은 라이브러리의 BridgeMethodHandling을 구현하고 NativeBridgeRouter로 WebView에 붙인다.
// 화면: 위는 WebView(React 앱), 아래는 Android View 네이티브 바 — 웹이 보낸 호출을 보여주고, RECEIVE 이벤트를 보내는 버튼이 있다.
package com.example.bridgegen.pingpoc

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
    /** 웹에서 호출이 들어올 때마다 네이티브 화면에 표시 */
    var onCall: (String) -> Unit = {}

    override suspend fun ping(params: PingParams): PongResult {
        if (params.message == "reject") {
            onCall("REQUEST ping(\"reject\") → throw PING_REJECTED")
            throw BridgeFailure(NativeErrorCode.PING_REJECTED, "rejected by PoC")
        }
        count++
        onCall("REQUEST ping(\"${params.message}\") → return pong (count $count)")
        return PongResult(reply = "pong: ${params.message}", platform = Platform.ANDROID)
    }
    override suspend fun resetPing() {
        count = 0
        onCall("REQUEST resetPing() → count 0")
    }
    override suspend fun logPing(params: PingParams) {
        log += params.message
        onCall("SEND logPing(\"${params.message}\") · 쌓인 로그 ${log.size}개")
        Log.i(TAG, "logPing: ${params.message}")
    }
    override suspend fun clearPingLog() {
        log.clear()
        onCall("SEND clearPingLog() · 쌓인 로그 0개")
    }
}

class MainActivity : ComponentActivity() {
    private var pingSeq = 0
    private var calls = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra("url") ?: "http://10.0.2.2:8787/index.html"
        val origin = Regex("^(https?://[^/]+)").find(url)!!.value
        WebView.setWebContentsDebuggingEnabled(true)
        val webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE

        val handler = PocHandler()
        val router = NativeBridgeRouter(
            handler = handler,
            scope = lifecycleScope,
            allowedOriginRules = setOf(origin),
            appVersion = "1.0.0",
            onLog = { name, reason -> Log.i(TAG, "router: $name $reason") },
        )
        router.attach(webView)

        // ── 네이티브 바 (Android View) ──
        val header = TextView(this).apply { textSize = 11f; setTextColor(Color.GRAY); text = "NATIVE · Android View" }
        val status = TextView(this).apply {
            textSize = 12f; typeface = Typeface.MONOSPACE; setTextColor(Color.BLACK); maxLines = 2
            text = "아직 웹에서 받은 호출 없음"
        }
        handler.onCall = { text ->
            runOnUiThread {
                calls++
                status.text = text
                header.text = "NATIVE · Android View   (웹 호출 ${calls}회)"
            }
        }
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(Button(context).apply {
                text = "nativePing 보내기"; isAllCaps = false
                setOnClickListener {
                    pingSeq++
                    router.send(BridgeEvent.NativePing(NativePingPayload(message = "Android 버튼 #$pingSeq", platform = Platform.ANDROID)))
                }
            })
            addView(Button(context).apply {
                text = "nativePingStopped"; isAllCaps = false
                setOnClickListener { router.send(BridgeEvent.NativePingStopped) }
            })
            addView(Button(context).apply { text = "↻"; setOnClickListener { webView.reload() } })
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(238, 238, 242))
            setPadding(32, 16, 32, 8)
            addView(header); addView(status); addView(buttons)
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(webView, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        // targetSdk 35 이상은 edge-to-edge → 시스템 바만큼 비켜 준다
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(0, 0, 0, b.bottom)
            insets
        }
        setContentView(root)

        webView.webViewClient = object : WebViewClient() {
            // RECEIVE: 웹이 보낸 것의 응답이 아니라 Native가 먼저 알린다 (페이지 로드 직후 한 번 — 자동 검사용).
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
