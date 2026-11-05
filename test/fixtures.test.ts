// fixtures 자체가 spec(JSON Schema)과 맞는지 확인한다. fixture가 틀리면 세 플랫폼 테스트가 다 같이 틀린다.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { parse } from 'yaml'
import { BRIDGE_METHOD_META } from './.gen/js/generated/contract'

const root = new URL('../', import.meta.url)
const spec = parse(readFileSync(new URL('examples/ping/asyncapi.yaml', root), 'utf8'))
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
ajv.addSchema({ $id: 'spec', components: spec.components }, 'spec')

/** '#/a/b/c' 를 spec 안에서 따라간다 */
const deref = (ref: string): any => ref.slice(2).split('/').reduce((n: any, k) => n[k], spec)
/** operation → params/result 스키마 이름 (operation 메시지 → channel 메시지 → components 메시지 → payload $ref) */
const opSchemas = (name: string): { payload: string; result?: string } => {
  const schemaOf = (msgRef: string) => {
    let msg = deref(msgRef)
    while (msg.$ref) msg = deref(msg.$ref)
    return (msg.payload.$ref as string).split('/').pop() as string
  }
  const op = spec.operations[name]
  return { payload: schemaOf(op.messages[0].$ref), result: op.reply ? schemaOf(op.reply.messages[0].$ref) : undefined }
}
const validate = (schemaName: string, value: unknown) => {
  const v = ajv.getSchema(`spec#/components/schemas/${schemaName}`)!
  return { ok: v(value) as boolean, errors: v.errors }
}

const load = (dir: string) =>
  readdirSync(new URL(`test/fixtures/${dir}/`, root))
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(new URL(`test/fixtures/${dir}/${f}`, root), 'utf8'))] as const)

const opName = (input: any): string | undefined => (input?.type === 'event' ? input.event : input?.method)

describe('native fixtures ↔ spec', () => {
  for (const [file, fx] of load('native')) {
    it(file, () => {
      if (!fx.expect) return
      // fixture는 error.message를 비교하지 않으려고 생략하므로, 스키마 검사 때만 채운다
      const expectEnv = fx.expect.error ? { ...fx.expect, error: { message: 'x', ...fx.expect.error } } : fx.expect
      const env = validate('RpcResponse', expectEnv)
      expect(env.ok, JSON.stringify(env.errors)).toBe(true)
      if (fx.expect.error) return
      // 성공 케이스: 입력 params와 result 모두 스키마에 맞아야 한다
      const { payload, result } = opSchemas(fx.input.method)
      const p = validate(payload, fx.input.params ?? {})
      expect(p.ok, `params: ${JSON.stringify(p.errors)}`).toBe(true)
      const r = validate(result!, fx.expect.result)
      expect(r.ok, `result: ${JSON.stringify(r.errors)}`).toBe(true)
    })
  }

  it('정상 emit fixture의 입력은 EventEnvelope와 payload 스키마에 맞다', () => {
    for (const [file, fx] of load('native')) {
      if (fx.input?.type !== 'event' || !fx.calls.length) continue
      expect(validate('EventEnvelope', fx.input).ok, file).toBe(true)
      expect(validate(opSchemas(fx.input.event).payload, fx.input.payload ?? {}).ok, file).toBe(true)
    }
  })

  it('INVALID_PARAMS · 잘못된 payload fixture의 입력은 실제로 스키마 위반이다', () => {
    for (const [file, fx] of load('native')) {
      if (!/invalid-params|invalid-payload/.test(file)) continue
      const value = fx.input.type === 'event' ? fx.input.payload : fx.input.params
      expect(validate(opSchemas(opName(fx.input)!).payload, value).ok, file).toBe(false)
    }
  })
})

describe('event fixtures ↔ spec', () => {
  for (const [file, fx] of load('events')) {
    it(file, () => {
      expect(BRIDGE_METHOD_META[fx.event as keyof typeof BRIDGE_METHOD_META].kind).toBe('event')
      expect(validate(opSchemas(fx.event).payload, fx.payload).ok).toBe(true)
      expect(validate('EventEnvelope', fx.expect).ok).toBe(true)
    })
  }
})

it('모든 operation이 최소 하나의 fixture로 다뤄진다', () => {
  const covered = new Set([
    ...load('native')
      .filter(([, fx]) => fx.calls.length)
      .map(([, fx]) => opName(fx.input)),
    ...load('events').map(([, fx]) => fx.event),
  ])
  const missing = Object.keys(BRIDGE_METHOD_META).filter((n) => !covered.has(n))
  expect(missing).toEqual([])
})
