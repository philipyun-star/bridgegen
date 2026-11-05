import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BridgeError,
  createBridge,
  detectAdapter,
  requestWithRetry,
  type BridgeAdapter,
  type BridgeCapabilities,
  type BridgeEnvelope,
  type BridgeLogEntry,
  type RpcRequest,
} from './.gen/js/src/index'

const caps = (over: Partial<BridgeCapabilities> = {}): BridgeCapabilities => ({
  version: 1,
  methods: ['ping', 'resetPing'],
  events: ['logPing', 'clearPingLog'],
  ...over,
})

const response = (req: RpcRequest, body: { result?: unknown; error?: unknown }) => ({
  type: 'rpc_response',
  id: req.id,
  version: 1,
  source: 'native',
  method: req.method,
  ...body,
})

function fakeIOS() {
  // sent: 계약 메시지만. 런타임 예약 이벤트(bridge.hello)는 hellos에 따로 모은다.
  const sent: BridgeEnvelope[] = []
  const hellos: unknown[] = []
  const win: any = {
    webkit: {
      messageHandlers: {
        bridge: { postMessage: (m: any) => (m?.event === 'bridge.hello' ? hellos.push(m) : sent.push(m)) },
      },
    },
  }
  const adapter = detectAdapter(win)!
  const fromNative = (env: unknown) => win.__receiveBridgeMessage(JSON.stringify(env))
  const lastRequest = () => sent[sent.length - 1] as RpcRequest
  return { win, sent, hellos, adapter, fromNative, lastRequest }
}

function fakeAndroid() {
  const sent: string[] = []
  const listeners: Array<(e: { data: string }) => void> = []
  const win: any = {
    bridge: {
      postMessage: (m: string) => sent.push(m),
      addEventListener: (_: string, l: (e: { data: string }) => void) => listeners.push(l),
    },
  }
  const adapter = detectAdapter(win)!
  const fromNative = (env: unknown) => listeners.forEach((l) => l({ data: JSON.stringify(env) }))
  return { sent, adapter, fromNative }
}

afterEach(() => vi.useRealTimers())

describe('Platform Adapter', () => {
  it('브릿지가 없으면 null · available=false · request는 UNAVAILABLE', async () => {
    expect(detectAdapter({} as any)).toBeNull()
    const bridge = createBridge({ adapter: null, capabilities: caps() })
    expect(bridge.available).toBe(false)
    await expect(bridge.request('ping', { message: 'hello' })).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: false })
  })

  it('iOS: window.__receiveBridgeMessage 는 덮어쓸 수 없다', () => {
    const { win } = fakeIOS()
    expect(() => {
      'use strict'
      win.__receiveBridgeMessage = () => {}
    }).toThrow()
  })

  it('같은 window에서 여러 번 감지해도 같은 adapter', () => {
    const { win, adapter } = fakeIOS()
    expect(detectAdapter(win)).toBe(adapter)
  })

  it('iOS: 수신 함수를 설치한 직후 bridge.hello를 보낸다 (Router가 쌓아 둔 이벤트를 이때 보냄)', () => {
    const { hellos } = fakeIOS()
    expect(hellos).toEqual([{ type: 'event', version: 1, source: 'web', target: 'native', event: 'bridge.hello' }])
  })

  it('Android: 연결 직후 bridge.hello 이벤트를 보낸다 (replyProxy 확보용)', () => {
    const { sent } = fakeAndroid()
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'event', version: 1, source: 'web', target: 'native', event: 'bridge.hello' })
  })
})

describe('bridge.request (RPC)', () => {
  it('rpc_request envelope을 보내고, id로 응답을 짝지어 순서가 바뀌어도 각자 결과를 받는다', async () => {
    const { sent, adapter, fromNative } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps() })
    const a = bridge.request('ping', { message: 'a' })
    const b = bridge.request('ping', { message: 'b' })
    const [ra, rb] = sent as RpcRequest[]
    expect(ra).toMatchObject({ type: 'rpc_request', version: 1, target: 'native', method: 'ping', params: { message: 'a' } })
    expect(ra!.id).not.toBe(rb!.id)

    fromNative(response(rb!, { result: { reply: 'pong: b', platform: 'ios' } }))
    fromNative(response(ra!, { result: { reply: 'pong: a', platform: 'ios' } }))
    await expect(a).resolves.toEqual({ reply: 'pong: a', platform: 'ios' })
    await expect(b).resolves.toEqual({ reply: 'pong: b', platform: 'ios' })
  })

  it('Native 오류는 NATIVE_ERROR로 정규화하고 details · retryable을 그대로 둔다', async () => {
    const { sent, adapter, fromNative } = fakeAndroid()
    const bridge = createBridge({ adapter, capabilities: caps() })
    const p = bridge.request('ping', { message: 'reject' })
    const req = JSON.parse(sent[1]!) as RpcRequest
    expect(req).toMatchObject({ type: 'rpc_request', method: 'ping', params: { message: 'reject' } })
    fromNative(response(req, { error: { code: 'NATIVE_ERROR', message: 'rejected', retryable: false, details: { code: 'PING_REJECTED' } } }))
    const err = await p.catch((e) => e)
    expect(err).toBeInstanceOf(BridgeError)
    expect(err).toMatchObject({ code: 'NATIVE_ERROR', retryable: false, details: { code: 'PING_REJECTED' }, method: 'ping' })
  })

  it('모르는 Native 코드는 NATIVE_ERROR로 본다', async () => {
    const { adapter, fromNative, lastRequest } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps() })
    const p = bridge.request('ping', { message: 'hello' })
    fromNative(response(lastRequest(), { error: { code: 'SOMETHING_NEW', message: 'x', retryable: true } }))
    await expect(p).rejects.toMatchObject({ code: 'NATIVE_ERROR', retryable: true })
  })

  it('Native가 UNSUPPORTED_VERSION으로 응답하면 그대로 전달', async () => {
    const { adapter, fromNative, lastRequest } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps() })
    const p = bridge.request('ping', { message: 'hello' })
    fromNative(response(lastRequest(), { error: { code: 'UNSUPPORTED_VERSION', message: 'v', retryable: false } }))
    await expect(p).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
  })

  it('TIMEOUT 뒤 늦게 온 응답은 무시하고 unmatched로 기록', async () => {
    vi.useFakeTimers()
    const logs: BridgeLogEntry[] = []
    const { adapter, fromNative, lastRequest } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps(), defaultTimeoutMs: 100, onLog: (l) => logs.push(l) })
    const p = bridge.request('resetPing')
    const settled = expect(p).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
    vi.advanceTimersByTime(100)
    await settled
    fromNative(response(lastRequest(), { result: {} }))
    expect(logs).toEqual([expect.objectContaining({ kind: 'unmatched', method: 'resetPing' })])
  })

  it('계약의 x-timeout-ms를 쓴다 (ping = 3000ms)', async () => {
    vi.useFakeTimers()
    const { adapter } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps(), defaultTimeoutMs: 60_000 })
    const p = bridge.request('ping', { message: 'hello' })
    const settled = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    vi.advanceTimersByTime(3000)
    await settled
  })

  it('중복 응답은 첫 응답만 처리', async () => {
    const logs: BridgeLogEntry[] = []
    const { adapter, fromNative, lastRequest } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps(), onLog: (l) => logs.push(l) })
    const p = bridge.request('ping', { message: 'hello' })
    const req = lastRequest()
    fromNative(response(req, { result: { reply: 'pong: hello', platform: 'ios' } }))
    fromNative(response(req, { result: { reply: 'pong: again', platform: 'android' } }))
    await expect(p).resolves.toMatchObject({ platform: 'ios' })
    expect(logs.map((l) => l.kind)).toEqual(['unmatched'])
  })

  it('형식 · version · source가 잘못된 응답은 INVALID_RESPONSE로 기록만 하고 요청은 기다린다', async () => {
    vi.useFakeTimers()
    const logs: BridgeLogEntry[] = []
    const { win, adapter, fromNative, lastRequest } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps(), defaultTimeoutMs: 50, onLog: (l) => logs.push(l) })
    const p = bridge.request('resetPing')
    const req = lastRequest()
    fromNative({ ...response(req, { result: {} }), version: 2 })
    fromNative({ ...response(req, { result: {} }), source: 'web' })
    win.__receiveBridgeMessage('{nope')
    expect(logs.map((l) => l.kind)).toEqual(['INVALID_RESPONSE', 'INVALID_RESPONSE', 'INVALID_RESPONSE'])
    const settled = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    vi.advanceTimersByTime(50)
    await settled
  })

  it('전송 호출이 실패하면 SEND_FAILED', async () => {
    const adapter: BridgeAdapter = {
      platform: 'custom',
      post: () => {
        throw new Error('boom')
      },
      subscribe: () => () => {},
    }
    const bridge = createBridge({ adapter, capabilities: caps() })
    await expect(bridge.request('ping', { message: 'hello' })).rejects.toMatchObject({ code: 'SEND_FAILED', retryable: true })
  })

  it('AbortSignal로 취소하면 ABORTED', async () => {
    const { adapter } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps() })
    const ac = new AbortController()
    const p = bridge.request('ping', { message: 'hello' }, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('dispose하면 남은 요청은 모두 ABORTED, 이후 응답은 무시', async () => {
    const { adapter, fromNative, lastRequest } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps() })
    const p = bridge.request('ping', { message: 'hello' })
    const req = lastRequest()
    bridge.dispose()
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' })
    expect(() => fromNative(response(req, { result: {} }))).not.toThrow()
    await expect(bridge.request('ping', { message: 'hello' })).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('버전 확인 (capabilities)', () => {
  it('앱이 지원하지 않는 method는 보내지 않고 UNSUPPORTED_VERSION (구 버전 앱)', async () => {
    const { sent, adapter } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps({ methods: ['ping'] }) })
    expect(bridge.isSupported('resetPing')).toBe(false)
    await expect(bridge.request('resetPing')).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
    expect(sent).toHaveLength(0)
  })

  it('capabilities가 없으면 fail-closed', () => {
    const { adapter } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: null })
    expect(bridge.isSupported('ping')).toBe(false)
    expect(bridge.isSupported('clearPingLog')).toBe(false)
  })

  it('envelope version이 다른 앱이면 모두 미지원', () => {
    const { adapter } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps({ version: 2 }) })
    expect(bridge.isSupported('ping')).toBe(false)
  })

  it('인스턴스를 만들 때 window.__bridgeCapabilities 를 읽는다', () => {
    const { adapter } = fakeIOS()
    ;(globalThis as any).__bridgeCapabilities = caps({ methods: ['ping'] })
    try {
      const bridge = createBridge({ adapter })
      expect(bridge.isSupported('ping')).toBe(true)
      expect(bridge.isSupported('resetPing')).toBe(false)
    } finally {
      delete (globalThis as any).__bridgeCapabilities
    }
  })
})

describe('bridge.emit · bridge.on', () => {
  it('emit은 source web의 event envelope이고 응답을 기다리지 않는다', () => {
    const { sent, adapter } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps() })
    expect(bridge.emit('logPing', { message: 'hello' })).toBe(true)
    expect(sent).toEqual([
      { type: 'event', version: 1, source: 'web', target: 'native', event: 'logPing', payload: { message: 'hello' } },
    ])
  })

  it('지원하지 않는 emit은 보내지 않고 false', () => {
    const logs: BridgeLogEntry[] = []
    const { sent, adapter } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps({ events: [] }), onLog: (l) => logs.push(l) })
    expect(bridge.emit('clearPingLog')).toBe(false)
    expect(sent).toHaveLength(0)
    expect(logs[0]).toMatchObject({ kind: 'emit_dropped', reason: 'UNSUPPORTED_VERSION' })
  })

  it('on: 구독자 여러 명에게 전달하고, 해제한 구독자에게는 다음 이벤트가 가지 않는다', () => {
    const { adapter, fromNative } = fakeAndroid()
    const bridge = createBridge({ adapter, capabilities: caps() })
    const a: string[] = []
    const b: string[] = []
    bridge.on('nativePing', ({ message }) => a.push(message))
    const offB = bridge.on('nativePing', ({ message }) => b.push(message))
    fromNative({ type: 'event', version: 1, source: 'native', event: 'nativePing', payload: { message: '1', platform: 'android' } })
    offB()
    fromNative({ type: 'event', version: 1, source: 'native', event: 'nativePing', payload: { message: '2', platform: 'android' } })
    expect(a).toEqual(['1', '2'])
    expect(b).toEqual(['1'])
  })

  it('한 구독자의 오류가 다른 구독자를 막지 않는다', () => {
    const logs: BridgeLogEntry[] = []
    const { adapter, fromNative } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps(), onLog: (l) => logs.push(l) })
    const seen: string[] = []
    bridge.on('nativePingStopped', () => {
      throw new Error('x')
    })
    bridge.on('nativePingStopped', () => seen.push('ok'))
    fromNative({ type: 'event', version: 1, source: 'native', event: 'nativePingStopped' })
    expect(seen).toEqual(['ok'])
    expect(logs[0]).toMatchObject({ kind: 'listener_error' })
  })
})

describe('requestWithRetry', () => {
  it('idempotent 요청은 retryable 오류에서 제한된 횟수만큼 다시 시도한다', async () => {
    vi.useFakeTimers()
    const { sent, adapter, fromNative } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps(), defaultTimeoutMs: 10 })
    const p = requestWithRetry(bridge, 'ping', { message: 'hello' }, { maxAttempts: 3, backoffMs: 5, timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10) // 1회 TIMEOUT
    await vi.advanceTimersByTimeAsync(5) // backoff
    expect(sent).toHaveLength(2)
    fromNative(response(sent[1] as RpcRequest, { result: { reply: 'pong: hello', platform: 'ios' } }))
    await expect(p).resolves.toEqual({ reply: 'pong: hello', platform: 'ios' })
  })

  it('idempotent가 아닌 요청(resetPing)은 재시도하지 않는다', async () => {
    vi.useFakeTimers()
    const { sent, adapter } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps() })
    const p = requestWithRetry(bridge, 'resetPing', {}, { timeoutMs: 10, backoffMs: 1 })
    const settled = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(50)
    await settled
    expect(sent).toHaveLength(1)
  })

  it('retryable이 false인 Native 오류는 재시도하지 않는다', async () => {
    const { sent, adapter, fromNative } = fakeIOS()
    const bridge = createBridge({ adapter, capabilities: caps() })
    const p = requestWithRetry(bridge, 'ping', { message: 'hello' })
    fromNative(response(sent[0] as RpcRequest, { error: { code: 'NATIVE_ERROR', message: 'x', retryable: false } }))
    await expect(p).rejects.toMatchObject({ code: 'NATIVE_ERROR' })
    expect(sent).toHaveLength(1)
  })
})
