// Platform Adapter: 플랫폼별 전송 방식 차이만 흡수한다. 메시지의 의미는 모른다.
//
//   iOS     : webkit.messageHandlers.bridge.postMessage(envelope)      ← window.__receiveBridgeMessage(envelope)
//   Android : window.bridge.postMessage(JSON) (addWebMessageListener)  ← window.bridge.onmessage
//
// 두 플랫폼 모두 수신은 같은 receive 함수 하나로 모인다.
import type { BridgeEnvelope } from './envelope.js'

export interface BridgeAdapter {
  readonly platform: 'ios' | 'android' | 'custom'
  /** 전송. 실패하면 throw → Core가 SEND_FAILED로 바꾼다. */
  post(envelope: BridgeEnvelope): void
  /** Native → Web 원문 수신. 해제 함수를 돌려준다. 해석·검증은 Core의 router가 한다. */
  subscribe(listener: (raw: unknown) => void): () => void
}

export type BridgeWindow = typeof globalThis & {
  webkit?: { messageHandlers?: { bridge?: { postMessage(message: unknown): void } } }
  bridge?: {
    postMessage(message: string): void
    onmessage?: ((event: MessageEvent) => void) | null
    addEventListener?(type: 'message', listener: (event: MessageEvent) => void): void
  }
  __receiveBridgeMessage?: (message: unknown) => void
  __bridgeCapabilities?: unknown
}

/**
 * 수신 준비가 끝났다고 Native Router에 알리는 예약 이벤트. 계약 operation이 아니다.
 * Router는 이걸 받기 전까지 Native → Web 이벤트를 쌓아 두었다가 받으면 보낸다 (페이지 로드 완료 시점엔 아직 수신 함수가 없을 수 있다).
 * Android는 이 메시지의 replyProxy를 이벤트 전송 경로로 쓴다.
 */
export const HELLO_EVENT = 'bridge.hello'

const cache = new WeakMap<object, BridgeAdapter>()

/** 브릿지가 없는 환경(일반 브라우저)이면 null. window마다 한 번만 만든다. */
export function detectAdapter(win: BridgeWindow = globalThis as BridgeWindow): BridgeAdapter | null {
  const cached = cache.get(win)
  if (cached) return cached
  const adapter = createAdapter(win)
  if (adapter) cache.set(win, adapter)
  return adapter
}

function createAdapter(win: BridgeWindow): BridgeAdapter | null {
  const listeners = new Set<(raw: unknown) => void>()
  const receive = (raw: unknown) => {
    for (const l of listeners) l(raw)
  }
  const subscribe = (l: (raw: unknown) => void) => {
    listeners.add(l)
    return () => void listeners.delete(l)
  }

  const ios = win.webkit?.messageHandlers?.bridge
  if (ios) {
    // 단일 수신 진입점. 페이지 스크립트가 덮어쓰지 못하도록 한 번만 정의한다.
    Object.defineProperty(win, '__receiveBridgeMessage', { value: receive, writable: false, configurable: false })
    ios.postMessage({ type: 'event', version: 1, source: 'web', target: 'native', event: HELLO_EVENT })
    return { platform: 'ios', post: (env) => ios.postMessage(env), subscribe }
  }

  const android = win.bridge
  if (android && typeof android.postMessage === 'function') {
    const onMessage = (event: MessageEvent) => receive(event.data)
    if (android.addEventListener) android.addEventListener('message', onMessage)
    else android.onmessage = onMessage
    android.postMessage(JSON.stringify({ type: 'event', version: 1, source: 'web', target: 'native', event: HELLO_EVENT }))
    return { platform: 'android', post: (env) => android.postMessage(JSON.stringify(env)), subscribe }
  }

  return null
}
