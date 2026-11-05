// 타입 수준 테스트: tsc --noEmit 로 검사된다 (pnpm typecheck)
import { BridgeError, createBridge, requestWithRetry } from './.gen/js/src/index'

const bridge = createBridge({ adapter: null })

async function typeChecks() {
  const pong = await bridge.request('ping', { message: 'hello' })
  const _reply: string = pong.reply
  const _platform: 'ios' | 'android' = pong.platform
  await bridge.request('resetPing')
  await requestWithRetry(bridge, 'ping', { message: 'hello' })
  const _sent: boolean = bridge.emit('logPing', { message: 'hello' })
  bridge.emit('clearPingLog')
  bridge.on('nativePing', (p) => {
    const _m: string = p.message
  })
  bridge.on('nativePingStopped', () => {})
  try {
    await bridge.request('ping', { message: 'reject' })
  } catch (e) {
    if (e instanceof BridgeError && e.code === 'NATIVE_ERROR') {
      const _detail: string | undefined = e.details?.code
    }
  }

  // @ts-expect-error 계약에 없는 method
  await bridge.request('nope')
  // @ts-expect-error 필수 params 누락
  await bridge.request('ping')
  // @ts-expect-error params 타입 불일치
  bridge.emit('logPing', { message: 123 })
  // @ts-expect-error emit을 request로 호출
  await bridge.request('logPing', { message: 'hello' })
  // @ts-expect-error Native → Web 이벤트는 emit 불가
  bridge.emit('nativePing', { message: 'hi', platform: 'ios' })
  // @ts-expect-error 없는 이벤트 구독
  bridge.on('nope', () => {})
}
void typeChecks
