// 자동 검사 6개. 페이지가 뜨면 한 번 돈다 → document.title = "PASS 6/6" · window.__pocResult
// poc/ios · poc/android 앱이 title을 보고 결과를 로그로 남긴다 (poc/run.sh가 읽음).
import { isBridgeError } from '@example/ping-bridge'
import { bridge, firstNativePing } from './bridge'

export type Badge = 'REQUEST' | 'SEND' | 'RECEIVE'
export type CheckResult = { badge: Badge; name: string; ok: boolean; detail: unknown }

export async function runChecks(): Promise<{ pass: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = []
  const step = (badge: Badge, name: string, ok: boolean, detail: unknown) => results.push({ badge, name, ok, detail })

  try {
    if (!bridge.available) {
      step('REQUEST', 'native bridge 없음 (일반 브라우저)', false, 'UNAVAILABLE')
    } else {
      const pong = await bridge.request('ping', { message: 'hello' })
      step('REQUEST', "ping('hello') → pong", pong.reply === 'pong: hello', pong)

      try {
        await bridge.request('ping', { message: 'reject' })
        step('REQUEST', "ping('reject') → PING_REJECTED", false, 'resolve됨')
      } catch (e) {
        const ok = isBridgeError(e) && e.code === 'NATIVE_ERROR' && (e.details as { code?: string } | undefined)?.code === 'PING_REJECTED'
        step('REQUEST', "ping('reject') → PING_REJECTED", ok, isBridgeError(e) ? { code: e.code, details: e.details } : String(e))
      }

      const reset = await bridge.request('resetPing')
      step('REQUEST', 'resetPing → {} (완료 확인)', JSON.stringify(reset) === '{}', reset)

      const sent = bridge.emit('logPing', { message: 'from web (auto)' })
      step('SEND', 'logPing (응답 없음)', sent === true, { sent })

      try {
        const p = await Promise.race([firstNativePing, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('5초 안에 오지 않음')), 5000))])
        step('RECEIVE', 'nativePing (Native가 먼저 보냄)', typeof p.message === 'string' && (p.platform === 'ios' || p.platform === 'android'), p)
      } catch (e) {
        step('RECEIVE', 'nativePing (Native가 먼저 보냄)', false, (e as Error).message)
      }

      const supported = (['ping', 'resetPing', 'logPing', 'clearPingLog'] as const).every((n) => bridge.isSupported(n))
      step('REQUEST', 'capabilities에 계약 operation이 모두 있음', supported, bridge.capabilities)
    }
  } catch (e) {
    step('REQUEST', '예상하지 못한 오류', false, String(isBridgeError(e) ? e.code : e))
  }

  const pass = results.length >= 6 && results.every((r) => r.ok)
  const w = window as typeof window & { __pocResult?: unknown }
  w.__pocResult = { pass, results }
  document.title = `${pass ? 'PASS' : 'FAIL'} ${results.filter((r) => r.ok).length}/${results.length}`
  return { pass, results }
}
