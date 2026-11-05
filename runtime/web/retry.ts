// 재시도 원칙: retryable이고, 계약에 x-idempotent: true인 읽기 요청만 제한된 횟수로 자동 재시도한다.
// 결제 · 권한 변경 · 화면 전환처럼 두 번 실행되면 안 되는 요청은 재시도하지 않는다.
import { BRIDGE_METHOD_META, type BridgeMethods } from '../generated/contract.js'
import type { Bridge, RequestOptions } from './bridge.js'
import { BridgeError } from './errors.js'

export interface RetryOptions extends RequestOptions {
  /** 첫 시도를 포함한 최대 횟수. 기본 3 */
  maxAttempts?: number
  /** 첫 대기 시간 (ms). 시도마다 두 배. 기본 300 */
  backoffMs?: number
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new BridgeError('retry', 'ABORTED', 'signal aborted'))), { once: true })
  })

export async function requestWithRetry<N extends keyof BridgeMethods>(
  bridge: Bridge,
  name: N,
  params: BridgeMethods[N]['params'],
  options: RetryOptions = {},
): Promise<BridgeMethods[N]['result']> {
  const { maxAttempts = 3, backoffMs = 300, ...requestOptions } = options
  const idempotent = BRIDGE_METHOD_META[name].idempotent
  const call = bridge.request as (n: N, p: unknown, o?: RequestOptions) => Promise<BridgeMethods[N]['result']>
  for (let attempt = 1; ; attempt++) {
    try {
      return await call(name, params, requestOptions)
    } catch (e) {
      const retry = idempotent && e instanceof BridgeError && e.retryable && attempt < maxAttempts
      if (!retry) throw e
      await sleep(backoffMs * 2 ** (attempt - 1), requestOptions.signal)
    }
  }
}
