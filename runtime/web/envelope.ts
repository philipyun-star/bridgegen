// 메시지 envelope. JSON-RPC 2.0을 그대로 쓰지 않고 request · response · notification 개념만 가져왔다.
import { BRIDGE_ENVELOPE_VERSION } from '../generated/contract.js'
import type { BridgeErrorWire } from './errors.js'

export interface RpcRequest {
  type: 'rpc_request'
  id: string
  version: typeof BRIDGE_ENVELOPE_VERSION
  target: 'native'
  method: string
  params?: unknown
}

export interface RpcResponse {
  type: 'rpc_response'
  id: string
  version: typeof BRIDGE_ENVELOPE_VERSION
  source: 'native'
  method: string
  result?: unknown
  error?: BridgeErrorWire
}

export interface EventEnvelope {
  type: 'event'
  version: typeof BRIDGE_ENVELOPE_VERSION
  source: 'web' | 'native'
  target?: 'native' | 'web' | 'broadcast'
  event: string
  payload?: unknown
}

export type BridgeEnvelope = RpcRequest | RpcResponse | EventEnvelope

/** 수신 검증 결과. 잘못된 것은 INVALID_RESPONSE로 기록만 한다. */
export type Received =
  | { ok: true; message: RpcResponse | (EventEnvelope & { source: 'native' }) }
  | { ok: false; reason: string; raw: unknown }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Native → Web 원문을 검사한다. 형식 · version · source까지만 본다 (result 필드 검증은 하지 않음). */
export function parseIncoming(raw: unknown): Received {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, reason: 'JSON이 아님', raw }
    }
  }
  if (!isObject(value)) return { ok: false, reason: '객체가 아님', raw }
  if (value.version !== BRIDGE_ENVELOPE_VERSION) return { ok: false, reason: `version ${String(value.version)}`, raw }
  if (value.source !== 'native') return { ok: false, reason: `source ${String(value.source)}`, raw }

  if (value.type === 'rpc_response') {
    if (typeof value.id !== 'string' || typeof value.method !== 'string') return { ok: false, reason: 'id·method 누락', raw }
    if (value.error !== undefined && !(isObject(value.error) && typeof value.error.code === 'string')) {
      return { ok: false, reason: 'error 형식', raw }
    }
    return { ok: true, message: value as unknown as RpcResponse }
  }
  if (value.type === 'event') {
    if (typeof value.event !== 'string') return { ok: false, reason: 'event 누락', raw }
    return { ok: true, message: value as unknown as EventEnvelope & { source: 'native' } }
  }
  return { ok: false, reason: `type ${String(value.type)}`, raw }
}
