import { HEADER, docLines, screaming } from './util.mjs'
import { isEmpty } from './model.mjs'

function ktType(ty) {
  switch (ty.t) {
    case 'ref':
      return ty.name
    case 'string':
      return 'String'
    case 'boolean':
      return 'Boolean'
    case 'integer':
      return 'Long'
    case 'number':
      return 'Double'
    case 'array':
      return `List<${ktType(ty.items)}>`
  }
}

const kdoc = (text, indent = '') => {
  const lines = docLines(text)
  if (!lines.length) return ''
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`
}

export function emitKotlin(model) {
  const pkg = model.codegen.kotlinPackage ?? 'bridge.contract'
  const ops = model.operations
  const byKind = (k) => ops.filter((o) => o.kind === k)
  const requests = byKind('request')
  const emits = byKind('emit')
  const events = byKind('event')

  let out = `${HEADER('//')}\n@file:Suppress("ktlint", "detekt:all", "RedundantVisibilityModifier")\n\npackage ${pkg}\n\n`
  out += `import kotlinx.coroutines.CancellationException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

public const val BRIDGE_CONTRACT_VERSION: String = "${model.version}"

/** envelope 형식 버전. 라이브러리 런타임이 소유하며 계약 버전과 따로 센다. */
public const val BRIDGE_ENVELOPE_VERSION: Int = 1

`

  for (const t of model.types) {
    out += kdoc(t.description)
    if (t.kind === 'enum') {
      out += `@Serializable\npublic enum class ${t.name}(public val wireValue: String) {\n`
      out += t.values.map((v) => `    @SerialName("${v}") ${screaming(v)}("${v}")`).join(',\n')
      out += `;\n}\n\n`
      continue
    }
    if (t.fields.length === 0) {
      out += `@Serializable\npublic data object ${t.name}\n\n`
      continue
    }
    out += `@Serializable\npublic data class ${t.name}(\n`
    out += t.fields
      .map((f) => `${kdoc(f.description, '    ')}    val ${f.name}: ${ktType(f.type)}${f.required ? '' : '? = null'}`)
      .join(',\n')
    out += `,\n)\n\n`
  }

  out += `/** Handler가 던지면 \`NATIVE_ERROR\` + \`details.code\` 로 웹에 전달된다. */
public class BridgeFailure(
    public val code: NativeErrorCode,
    override val message: String,
    public val retryable: Boolean = false,
) : Exception(message)

/** bridge.request로 부를 수 있는 method (화이트리스트) */
public enum class BridgeMethod(public val wireName: String) {
${requests.map((o) => `    ${screaming(o.camel)}("${o.name}")`).join(',\n')};

    public companion object {
        public fun fromWire(name: String?): BridgeMethod? = entries.firstOrNull { it.wireName == name }
    }
}

/** bridge.emit으로 받을 수 있는 event (화이트리스트) */
public enum class BridgeEmit(public val wireName: String) {
${emits.map((o) => `    ${screaming(o.camel)}("${o.name}")`).join(',\n')};

    public companion object {
        public fun fromWire(name: String?): BridgeEmit? = entries.firstOrNull { it.wireName == name }
    }
}

/**
 * 계약의 method · emit을 처리한다. 앱의 Native Handler가 구현한다.
 * 계약에 operation이 추가되면 구현하지 않은 Handler는 컴파일되지 않는다.
 */
public interface BridgeMethodHandling {
`
  for (const o of requests) {
    out += kdoc(`[request] ${o.summary}`, '    ')
    const param = isEmpty(model, o.payload) ? '' : `params: ${o.payload}`
    const ret = !isEmpty(model, o.result) ? `: ${o.result}` : ''
    out += `    public suspend fun ${o.camel}(${param})${ret}\n`
  }
  for (const o of emits) {
    out += kdoc(`[emit] ${o.summary}`, '    ')
    const param = isEmpty(model, o.payload) ? '' : `params: ${o.payload}`
    out += `    public suspend fun ${o.camel}(${param})\n`
  }
  out += `}

/** Native → Web 푸시 이벤트 (bridge.on) */
public sealed interface BridgeEvent {
    public val name: String

`
  for (const o of events) {
    out += kdoc(o.summary, '    ')
    out += isEmpty(model, o.payload)
      ? `    public data object ${o.pascal} : BridgeEvent {\n        override val name: String = "${o.name}"\n    }\n\n`
      : `    public data class ${o.pascal}(val payload: ${o.payload}) : BridgeEvent {\n        override val name: String = "${o.name}"\n    }\n\n`
  }
  out += `    /** replyProxy.postMessage(...) 에 넘길 event envelope JSON */
    public fun toEnvelopeJson(): String {
        val payload: JsonElement = when (this) {
`
  for (const o of events) {
    out += isEmpty(model, o.payload)
      ? `            is ${o.pascal} -> JsonObject(emptyMap())\n`
      : `            is ${o.pascal} -> BridgeMessageProcessor.json.encodeToJsonElement(${o.payload}.serializer(), payload)\n`
  }
  out += `        }
        return buildJsonObject {
            put("type", "event")
            put("version", BRIDGE_ENVELOPE_VERSION)
            put("source", "native")
            put("event", name)
            put("payload", payload)
        }.toString()
    }
}

/**
 * 수신 envelope을 검사하고 Handler로 나눈다. WebView를 모르므로 conformance 픽스처로 그대로 테스트한다.
 * 규칙은 iOS의 BridgeMessageProcessor와 같다 (fixtures/native 폴더의 픽스처).
 */
public object BridgeMessageProcessor {
    public val json: Json = Json {
        ignoreUnknownKeys = true
        // optional 필드는 모두 '= null' 기본값이므로, null이면 키 자체를 생략한다.
        encodeDefaults = false
    }

    /** \`window.__bridgeCapabilities\` 주입에 쓰는 지원 범위 */
    public val methods: List<String> = BridgeMethod.entries.map { it.wireName }
    public val events: List<String> = BridgeEmit.entries.map { it.wireName }

    private class InvalidParams : Exception()

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** JSON 정수만 받는다. 문자열 "1"이나 true는 정수가 아니다. */
    private fun JsonObject.integer(key: String): Long? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

    private fun <P> decode(serializer: KSerializer<P>, value: JsonElement?): P {
        val obj = when (value) {
            null, JsonNull -> JsonObject(emptyMap())
            is JsonObject -> value
            else -> throw InvalidParams()
        }
        return json.decodeFromJsonElement(serializer, obj)
    }

    /** @return 웹에 돌려줄 rpc_response JSON. 응답하지 않을 때는 null. */
    public suspend fun handle(
        message: String,
        handler: BridgeMethodHandling,
        onLog: ((name: String, reason: String) -> Unit)? = null,
    ): String? {
        val obj = try {
            json.parseToJsonElement(message) as? JsonObject
        } catch (e: SerializationException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        }
        val type = obj?.string("type")
        if (obj == null || type == null) {
            onLog?.invoke("?", "envelope 형식 아님 · 버림")
            return null
        }
        val version = obj.integer("version")

        when (type) {
            "rpc_request" -> {
                val id = obj.string("id")
                val method = obj.string("method")
                if (id == null || obj.string("target") != "native" || method == null) {
                    onLog?.invoke("?", "rpc_request 필수 필드(id 문자열, target native, method) 오류 · 버림")
                    return null
                }

                fun fail(code: BridgeErrorCode, msg: String, details: NativeErrorCode? = null, retryable: Boolean = false): String {
                    onLog?.invoke(method, "\${details?.wireValue ?: code.wireValue}: $msg")
                    val error = BridgeError(code = code, message = msg, retryable = retryable, details = details?.let { BridgeErrorDetails(it) })
                    return response(id, method) { put("error", json.encodeToJsonElement(BridgeError.serializer(), error)) }
                }

                fun <R> reply(serializer: KSerializer<R>, result: R): String =
                    response(id, method) { put("result", json.encodeToJsonElement(serializer, result)) }

                if (version != BRIDGE_ENVELOPE_VERSION.toLong()) {
                    return fail(BridgeErrorCode.UNSUPPORTED_VERSION, "envelope version \${obj["version"]} 미지원")
                }
                val m = BridgeMethod.fromWire(method)
                    ?: return fail(BridgeErrorCode.NATIVE_ERROR, "화이트리스트에 없는 method", NativeErrorCode.METHOD_NOT_ALLOWED)

                return try {
                    when (m) {
`
  for (const o of requests) {
    const call = isEmpty(model, o.payload) ? `handler.${o.camel}()` : `handler.${o.camel}(decode(${o.payload}.serializer(), obj["params"]))`
    out += `                        BridgeMethod.${screaming(o.camel)} -> `
    out += isEmpty(model, o.result)
      ? `{\n                            ${call}\n                            reply(EmptyPayload.serializer(), EmptyPayload)\n                        }\n`
      : `reply(${o.result}.serializer(), ${call})\n`
  }
  out += `                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: BridgeFailure) {
                    fail(BridgeErrorCode.NATIVE_ERROR, e.message, e.code, e.retryable)
                } catch (e: InvalidParams) {
                    fail(BridgeErrorCode.NATIVE_ERROR, "params가 계약과 다름", NativeErrorCode.INVALID_PARAMS)
                } catch (e: SerializationException) {
                    fail(BridgeErrorCode.NATIVE_ERROR, "params가 계약과 다름", NativeErrorCode.INVALID_PARAMS)
                } catch (e: IllegalArgumentException) {
                    fail(BridgeErrorCode.NATIVE_ERROR, "params가 계약과 다름", NativeErrorCode.INVALID_PARAMS)
                } catch (e: Exception) {
                    fail(BridgeErrorCode.NATIVE_ERROR, e.toString(), NativeErrorCode.INTERNAL)
                }
            }

            "event" -> {
                val name = obj.string("event")
                val target = obj["target"]
                if (version != BRIDGE_ENVELOPE_VERSION.toLong() || obj.string("source") != "web" ||
                    !(target == null || obj.string("target") == "native") || name == null
                ) {
                    onLog?.invoke("?", "event 필수 필드(version 1, source web, event) 오류 · 버림")
                    return null
                }
                val e = BridgeEmit.fromWire(name)
                if (e == null) {
                    onLog?.invoke(name, "화이트리스트에 없는 event · 버림")
                    return null
                }
                try {
                    when (e) {
`
  for (const o of emits) {
    const call = isEmpty(model, o.payload) ? `handler.${o.camel}()` : `handler.${o.camel}(decode(${o.payload}.serializer(), obj["payload"]))`
    out += `                        BridgeEmit.${screaming(o.camel)} -> ${call}\n`
  }
  out += `                    }
                } catch (ex: CancellationException) {
                    throw ex
                } catch (ex: InvalidParams) {
                    onLog?.invoke(name, "payload가 계약과 다름 · 버림")
                } catch (ex: SerializationException) {
                    onLog?.invoke(name, "payload가 계약과 다름 · 버림")
                } catch (ex: IllegalArgumentException) {
                    onLog?.invoke(name, "payload가 계약과 다름 · 버림")
                } catch (ex: Exception) {
                    onLog?.invoke(name, "Handler 오류: $ex")
                }
                return null
            }

            else -> {
                onLog?.invoke("?", "모르는 type $type · 버림")
                return null
            }
        }
    }

    private inline fun response(id: String, method: String, body: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String =
        buildJsonObject {
            put("type", "rpc_response")
            put("id", id)
            put("version", BRIDGE_ENVELOPE_VERSION)
            put("source", "native")
            put("method", method)
            body()
        }.toString()
}
`
  return out
}
