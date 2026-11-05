// 앱 전체에서 하나만 쓰는 bridge. React 렌더 밖(모듈 로드 시점)에 만든다.
//   - 기본 adapter를 감싸 주고받는 envelope 원문을 로그 store에 쌓는다 (라이브러리는 그대로)
//   - RECEIVE 이벤트는 React가 마운트되기 전에 올 수 있어 여기서 바로 구독해 store에 쌓는다
import { createBridge, detectAdapter, type BridgeAdapter, type BridgeEvents, type NativePingPayload } from '@example/ping-bridge'

function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      listeners.forEach((l) => l())
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}

export type LogEntry = { id: number; ms: number; dir: 'out' | 'in'; env: unknown }
export type Received = { id: number; ms: number; name: keyof BridgeEvents; payload: unknown }

const t0 = performance.now()
let seq = 0
const now = () => Math.round(performance.now() - t0)

export const logStore = createStore<LogEntry[]>([])
export const receivedStore = createStore<Received[]>([])

function log(dir: LogEntry['dir'], raw: unknown) {
  let env = raw
  if (typeof raw === 'string') try { env = JSON.parse(raw) } catch { /* 원문 그대로 */ }
  logStore.set([...logStore.get(), { id: ++seq, ms: now(), dir, env }])
}

// detectAdapter()가 bridge.hello를 보내므로 감싸기 전에 나간다 → 로그에 직접 남긴다
const base = detectAdapter()
if (base) log('out', { type: 'event', version: 1, source: 'web', target: 'native', event: 'bridge.hello' })

const adapter: BridgeAdapter | null = base && {
  platform: base.platform,
  post: (env) => {
    log('out', env)
    base.post(env)
  },
  subscribe: (listener) =>
    base.subscribe((raw) => {
      log('in', raw)
      listener(raw)
    }),
}

export const bridge = createBridge({ adapter })

const keep = (name: keyof BridgeEvents) => (payload: unknown) =>
  receivedStore.set([...receivedStore.get(), { id: ++seq, ms: now(), name, payload }])
bridge.on('nativePing', keep('nativePing'))
bridge.on('nativePingStopped', keep('nativePingStopped'))

/** 자동 검사용: 앱이 페이지 로드 뒤 먼저 보내는 첫 nativePing */
export const firstNativePing = new Promise<NativePingPayload>((resolve) => {
  const off = bridge.on('nativePing', (p) => {
    off()
    resolve(p)
  })
})
