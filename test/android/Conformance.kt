// bridgegen이 만든 BridgeContract.kt + 이 파일을 kotlinc로 함께 컴파일해 fixtures를 돌린다.
import com.example.pingbridge.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.File
import kotlin.system.exitProcess

class FixtureHandler : BridgeMethodHandling {
    val calls = mutableListOf<String>()
    override suspend fun ping(params: PingParams): PongResult {
        calls += "ping"
        if (params.message == "reject") throw BridgeFailure(NativeErrorCode.PING_REJECTED, "ping rejected")
        return PongResult(reply = "pong: ${params.message}", platform = Platform.IOS)
    }
    override suspend fun resetPing() {
        calls += "resetPing"
    }
    override suspend fun logPing(params: PingParams) {
        calls += "logPing"
    }
    override suspend fun clearPingLog() {
        calls += "clearPingLog"
    }
}

/** error.message는 플랫폼별 문구라 비교에서 뺀다 */
fun normalize(e: JsonElement?): JsonElement? {
    if (e !is JsonObject) return e
    val err = e["error"] as? JsonObject ?: return e
    return JsonObject(e + ("error" to JsonObject(err - "message")))
}

fun main(args: Array<String>): Unit = runBlocking {
    val dir = File(args[0])
    var failed = 0
    var total = 0

    for (file in File(dir, "native").listFiles()!!.filter { it.name.endsWith(".json") }.sortedBy { it.name }) {
        total++
        val fx = Json.parseToJsonElement(file.readText()).jsonObject
        val input = fx["inputRaw"]?.jsonPrimitive?.content ?: fx["input"].toString()
        val handler = FixtureHandler()
        val out = BridgeMessageProcessor.handle(input, handler)
        val actual = out?.let { Json.parseToJsonElement(it) }
        val expected = fx["expect"].takeUnless { it is JsonNull }
        val expectedCalls = fx["calls"]!!.jsonArray.map { it.jsonPrimitive.content }

        val problems = mutableListOf<String>()
        if (normalize(actual) != normalize(expected)) problems += "response\n      expected: $expected\n      actual:   $out"
        val error = (actual as? JsonObject)?.get("error") as? JsonObject
        if (error != null && (error["message"] as? JsonPrimitive)?.isString != true) problems += "error.message가 문자열이 아님"
        if (handler.calls != expectedCalls) problems += "calls expected $expectedCalls actual ${handler.calls}"
        if (problems.isEmpty()) {
            println("  ✓ native/${file.name}")
        } else {
            failed++
            println("  ✖ native/${file.name}\n    " + problems.joinToString("\n    "))
        }
    }

    for (file in File(dir, "events").listFiles()!!.filter { it.name.endsWith(".json") }.sortedBy { it.name }) {
        total++
        val fx = Json.parseToJsonElement(file.readText()).jsonObject
        val event: BridgeEvent = when (val name = fx["event"]!!.jsonPrimitive.content) {
            "nativePing" -> BridgeEvent.NativePing(
                BridgeMessageProcessor.json.decodeFromJsonElement(NativePingPayload.serializer(), fx["payload"]!!),
            )
            "nativePingStopped" -> BridgeEvent.NativePingStopped
            else -> error("테스트에 이벤트 매핑 추가 필요: $name")
        }
        val actual = Json.parseToJsonElement(event.toEnvelopeJson())
        if (actual == fx["expect"]) {
            println("  ✓ events/${file.name}")
        } else {
            failed++
            println("  ✖ events/${file.name}\n    actual: $actual")
        }
    }

    println(if (failed == 0) "Android conformance: $total/$total 통과" else "Android conformance: $failed/$total 실패")
    exitProcess(if (failed == 0) 0 else 1)
}
