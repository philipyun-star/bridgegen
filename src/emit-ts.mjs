import { HEADER, docLines } from './util.mjs'

function tsType(ty) {
  switch (ty.t) {
    case 'ref':
      return ty.name
    case 'string':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'integer':
    case 'number':
      return 'number'
    case 'array':
      return `ReadonlyArray<${tsType(ty.items)}>`
  }
}

const jsdoc = (text, indent = '') => {
  const lines = docLines(text)
  if (!lines.length) return ''
  if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`
}

export function emitTs(model) {
  let out = `${HEADER('//')}\n`
  out += `export const BRIDGE_CONTRACT_VERSION = '${model.version}' as const\n`
  out += `/** envelope 형식 버전. 라이브러리 런타임이 소유하며 계약 버전과 따로 센다. */\nexport const BRIDGE_ENVELOPE_VERSION = 1 as const\n\n`

  for (const t of model.types) {
    out += jsdoc(t.description)
    if (t.kind === 'enum') {
      out += `export type ${t.name} = ${t.values.map((v) => `'${v}'`).join(' | ')}\n\n`
    } else if (t.fields.length === 0) {
      out += `export type ${t.name} = Record<string, never>\n\n`
    } else {
      out += `export interface ${t.name} {\n`
      for (const f of t.fields) {
        out += jsdoc(f.description, '  ')
        out += `  readonly ${f.name}${f.required ? '' : '?'}: ${tsType(f.type)}\n`
      }
      out += `}\n\n`
    }
  }

  const byKind = (k) => model.operations.filter((o) => o.kind === k)

  out += `/** bridge.request로 부르는 RPC (Web → Native). params와 result 타입이 method 이름에 묶인다. */\nexport interface BridgeMethods {\n`
  for (const o of byKind('request')) {
    out += jsdoc(o.summary, '  ')
    out += `  '${o.name}': { params: ${o.payload}; result: ${o.result} }\n`
  }
  out += `}\n\n/** bridge.emit으로 보내는 단방향 명령 (Web → Native). */\nexport interface BridgeEmits {\n`
  for (const o of byKind('emit')) {
    out += jsdoc(o.summary, '  ')
    out += `  '${o.name}': ${o.payload}\n`
  }
  out += `}\n\n/** bridge.on으로 구독하는 이벤트 (Native → Web). */\nexport interface BridgeEvents {\n`
  for (const o of byKind('event')) {
    out += jsdoc(o.summary, '  ')
    out += `  '${o.name}': ${o.payload}\n`
  }
  out += `}\n\n`

  out += `export type BridgeOperationName = keyof BridgeMethods | keyof BridgeEmits | keyof BridgeEvents\n\n`
  out += `export interface BridgeMethodMeta {
  readonly kind: 'request' | 'emit' | 'event'
  /** 처음 지원한 앱 버전. null이면 미지원 */
  readonly since: { readonly ios: string | null; readonly android: string | null }
  /** 읽기 전용이라 자동 재시도해도 되는 요청 */
  readonly idempotent: boolean
  /** 요청별 timeout (ms). null이면 Bridge Core 기본값 */
  readonly timeoutMs: number | null
}

/** 버전 확인, 재시도, timeout 판단에 쓰는 메타데이터. */
export const BRIDGE_METHOD_META = {
`
  for (const o of model.operations) {
    const s = (v) => (v == null ? 'null' : `'${v}'`)
    out += `  '${o.name}': { kind: '${o.kind}', since: { ios: ${s(o.since.ios)}, android: ${s(o.since.android)} }, idempotent: ${o.idempotent}, timeoutMs: ${o.timeoutMs ?? 'null'} },\n`
  }
  out += `} as const satisfies Record<BridgeOperationName, BridgeMethodMeta>\n`
  return out
}
