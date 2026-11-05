// Bridge Core (손으로 작성). 바깥에는 request · emit · on 만 노출한다.
//
//   const bridge = createBridge()
//   const pong = await bridge.request('ping', { message: 'hello' })
//   bridge.emit('logPing', { message: 'hello' })
//   const off = bridge.on('nativePing', ({ message }) => ...)
//
// 안에서 하는 일
//   rpc     : id 생성, pending map, timeout, 응답 매칭
//   emitter : on/off, 구독자 1:N dispatch
//   router  : 수신 envelope의 type으로 rpc_response와 event를 나눈다. 잘못된 것은 INVALID_RESPONSE로 기록만
//   errors  : 모든 실패를 BridgeError로 정규화
import {
  BRIDGE_CONTRACT_VERSION,
  BRIDGE_ENVELOPE_VERSION,
  BRIDGE_METHOD_META,
  type BridgeEmits,
  type BridgeEvents,
  type BridgeMethods,
  type BridgeOperationName,
  type EmptyPayload,
} from '../generated/contract.js'
import { detectAdapter, type BridgeAdapter, type BridgeWindow } from './adapter.js'
import { parseIncoming } from './envelope.js'
import { BridgeError } from './errors.js'

/** Native Router가 attach() 때 문서 시작 스크립트로 주입한다 (`window.__bridgeCapabilities`). */
export interface BridgeCapabilities {
  /** 앱이 지원하는 envelope version */
  readonly version: number
  /** bridge.request로 부를 수 있는 method */
  readonly methods: readonly string[]
  /** bridge.emit으로 보낼 수 있는 event */
  readonly events: readonly string[]
  readonly platform?: 'ios' | 'android'
  readonly appVersion?: string
  readonly contractVersion?: string
}

/** 로그에는 id · method · 오류 코드만 남긴다. payload와 token은 남기지 않는다. */
export interface BridgeLogEntry {
  readonly kind: 'INVALID_RESPONSE' | 'unmatched' | 'listener_error' | 'emit_dropped'
  readonly reason: string
  readonly id?: string
  readonly method?: string
}

export interface CreateBridgeOptions {
  /** 기본값: detectAdapter() */
  adapter?: BridgeAdapter | null
  /** 기본값: window.__bridgeCapabilities 를 인스턴스를 만들 때 한 번 읽는다 */
  capabilities?: BridgeCapabilities | null
  /** 계약에 x-timeout-ms가 없을 때의 timeout. 기본 10초 */
  defaultTimeoutMs?: number
  generateId?: () => string
  onLog?: (entry: BridgeLogEntry) => void
}

export interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

type ParamsArg<P> = [P] extends [EmptyPayload] ? [params?: P, options?: RequestOptions] : [params: P, options?: RequestOptions]
type PayloadArg<P> = [P] extends [EmptyPayload] ? [payload?: P] : [payload: P]

export interface Bridge {
  readonly available: boolean
  readonly platform: BridgeAdapter['platform'] | null
  readonly contractVersion: typeof BRIDGE_CONTRACT_VERSION
  readonly capabilities: BridgeCapabilities | null
  /** 앱이 이 method · event를 지원하는지. capabilities가 없으면 false (fail-closed) */
  isSupported(name: BridgeOperationName): boolean
  /** RPC. 결과 · 실패 · 시간 제한을 Promise로 돌려준다. 실패는 항상 BridgeError. */
  request<N extends keyof BridgeMethods>(name: N, ...args: ParamsArg<BridgeMethods[N]['params']>): Promise<BridgeMethods[N]['result']>
  /** 단방향 명령. 응답을 기다리지 않는다. 보냈으면 true. */
  emit<N extends keyof BridgeEmits>(name: N, ...args: PayloadArg<BridgeEmits[N]>): boolean
  /** Native → Web 푸시 이벤트 구독. 해제 함수를 돌려준다. */
  on<N extends keyof BridgeEvents>(name: N, listener: (payload: BridgeEvents[N]) => void): () => void
  /** 남은 요청을 모두 ABORTED로 끝내고 구독을 해제한다. Provider unmount 때 부른다. */
  dispose(): void
}

let seq = 0
const defaultId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `b${Date.now().toString(36)}-${++seq}`

function readCapabilities(): BridgeCapabilities | null {
  const raw = (globalThis as BridgeWindow).__bridgeCapabilities as Partial<BridgeCapabilities> | undefined
  if (!raw || typeof raw.version !== 'number' || !Array.isArray(raw.methods) || !Array.isArray(raw.events)) return null
  return raw as BridgeCapabilities
}

export function createBridge(options: CreateBridgeOptions = {}): Bridge {
  const adapter = options.adapter === undefined ? detectAdapter() : options.adapter
  const capabilities = options.capabilities === undefined ? readCapabilities() : options.capabilities
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000
  const generateId = options.generateId ?? defaultId
  const log = options.onLog ?? (() => {})

  type Pending = { method: string; resolve(v: unknown): void; reject(e: BridgeError): void; cleanup(): void }
  const pending = new Map<string, Pending>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let disposed = false

  // ── router ──
  const unsubscribe = adapter?.subscribe((raw) => {
    const received = parseIncoming(raw)
    if (!received.ok) return log({ kind: 'INVALID_RESPONSE', reason: received.reason })
    const msg = received.message
    if (msg.type === 'rpc_response') {
      const p = pending.get(msg.id)
      // 이미 timeout · 취소됐거나 중복 응답: 결과를 바꾸지 않고 기록만
      if (!p) return log({ kind: 'unmatched', reason: '모르는 id', id: msg.id, method: msg.method })
      p.cleanup()
      if (msg.error) p.reject(BridgeError.fromWire(p.method, msg.error))
      else p.resolve(msg.result ?? {})
      return
    }
    for (const l of listeners.get(msg.event) ?? []) {
      try {
        l(msg.payload ?? {})
      } catch (e) {
        // 한 구독자의 오류가 다른 구독자를 막지 않는다
        log({ kind: 'listener_error', reason: String(e), method: msg.event })
      }
    }
  })

  const isSupported = (name: BridgeOperationName): boolean => {
    if (!adapter || !capabilities || capabilities.version !== BRIDGE_ENVELOPE_VERSION) return false
    switch (BRIDGE_METHOD_META[name]?.kind) {
      case 'request':
        return capabilities.methods.includes(name)
      case 'emit':
        return capabilities.events.includes(name)
      case 'event':
        return true
      default:
        return false
    }
  }

  return {
    available: adapter != null,
    platform: adapter?.platform ?? null,
    contractVersion: BRIDGE_CONTRACT_VERSION,
    capabilities,
    isSupported,

    request(name, ...args) {
      const [params, opts] = args as [unknown, RequestOptions | undefined]
      if (!adapter) return Promise.reject(new BridgeError(name, 'UNAVAILABLE', 'Native 브릿지가 없음'))
      if (disposed) return Promise.reject(new BridgeError(name, 'ABORTED', 'bridge disposed'))
      if (!isSupported(name)) return Promise.reject(new BridgeError(name, 'UNSUPPORTED_VERSION', '이 앱 버전에서 지원하지 않음'))
      if (opts?.signal?.aborted) return Promise.reject(new BridgeError(name, 'ABORTED', 'signal aborted'))

      const timeoutMs = opts?.timeoutMs ?? BRIDGE_METHOD_META[name].timeoutMs ?? defaultTimeoutMs
      return new Promise((resolve, reject) => {
        const id = generateId()
        const timer = setTimeout(() => {
          cleanup()
          reject(new BridgeError(name, 'TIMEOUT', `${timeoutMs}ms 안에 응답 없음`))
        }, timeoutMs)
        const onAbort = () => {
          cleanup()
          reject(new BridgeError(name, 'ABORTED', 'signal aborted'))
        }
        const cleanup = () => {
          clearTimeout(timer)
          opts?.signal?.removeEventListener('abort', onAbort)
          pending.delete(id)
        }
        opts?.signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, { method: name, resolve: resolve as (v: unknown) => void, reject, cleanup })
        try {
          adapter.post({ type: 'rpc_request', id, version: BRIDGE_ENVELOPE_VERSION, target: 'native', method: name, params: params ?? {} })
        } catch (e) {
          cleanup()
          reject(new BridgeError(name, 'SEND_FAILED', String(e), { cause: e }))
        }
      })
    },

    emit(name, ...args) {
      if (!adapter || disposed || !isSupported(name)) {
        log({ kind: 'emit_dropped', reason: !adapter ? 'UNAVAILABLE' : disposed ? 'ABORTED' : 'UNSUPPORTED_VERSION', method: name })
        return false
      }
      try {
        adapter.post({ type: 'event', version: BRIDGE_ENVELOPE_VERSION, source: 'web', target: 'native', event: name, payload: args[0] ?? {} })
        return true
      } catch (e) {
        log({ kind: 'emit_dropped', reason: `SEND_FAILED ${String(e)}`, method: name })
        return false
      }
    },

    on(name, listener) {
      let set = listeners.get(name)
      if (!set) listeners.set(name, (set = new Set()))
      const l = listener as (payload: unknown) => void
      set.add(l)
      return () => void set.delete(l)
    },

    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      for (const p of [...pending.values()]) {
        p.cleanup()
        p.reject(new BridgeError(p.method, 'ABORTED', 'bridge disposed'))
      }
      listeners.clear()
    },
  }
}
