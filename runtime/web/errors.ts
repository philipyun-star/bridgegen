// 표준 BridgeError. Native가 준 오류와 Bridge Core가 만든 오류를 같은 모양으로 맞춘다.
import type { BridgeError as BridgeErrorWire, BridgeErrorCode, NativeErrorCode } from '../generated/contract.js'

export type { BridgeErrorWire }

/** 코드별 기본 retryable. NATIVE_ERROR는 Native가 준 값을 따른다. */
const DEFAULT_RETRYABLE: Record<BridgeErrorCode, boolean> = {
  UNAVAILABLE: false,
  SEND_FAILED: true,
  TIMEOUT: true,
  NATIVE_ERROR: false,
  INVALID_RESPONSE: false,
  UNSUPPORTED_VERSION: false,
  ABORTED: false,
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  readonly retryable: boolean
  /** NATIVE_ERROR일 때 Native의 오류 코드 */
  readonly details?: { readonly code: NativeErrorCode | (string & {}) }
  /** 어느 method·event에서 났는지 */
  readonly method: string

  constructor(
    method: string,
    code: BridgeErrorCode,
    message: string,
    options: { retryable?: boolean; details?: { code: string }; cause?: unknown } = {},
  ) {
    super(`[bridge] ${method}: ${code} ${message}`)
    this.name = 'BridgeError'
    this.method = method
    this.code = code
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code]
    if (options.details) this.details = options.details
    if (options.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false })
  }

  /** rpc_response.error → BridgeError. 모르는 코드는 NATIVE_ERROR로 본다. */
  static fromWire(method: string, wire: Partial<BridgeErrorWire> | undefined): BridgeError {
    const code = wire?.code === 'UNSUPPORTED_VERSION' ? 'UNSUPPORTED_VERSION' : 'NATIVE_ERROR'
    const details = wire?.details && typeof wire.details.code === 'string' ? { code: wire.details.code } : undefined
    return new BridgeError(method, code, typeof wire?.message === 'string' ? wire.message : '', {
      retryable: typeof wire?.retryable === 'boolean' ? wire.retryable : false,
      details,
    })
  }
}

export const isBridgeError = (e: unknown): e is BridgeError => e instanceof BridgeError
