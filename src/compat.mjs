#!/usr/bin/env node
// 이전 릴리스 spec과 비교해 깨지는 변경(breaking)을 찾는다.
//   node generator/compat.mjs <base-spec.yaml> [head-spec.yaml]   (CI는 직전 태그의 spec을 넘긴다)
//
// 규칙 — 웹과 앱은 따로 배포되므로 "새 웹 + 구 앱", "구 웹 + 새 앱" 이 동시에 존재한다.
//   breaking (major 필요)
//     - operation 삭제·kind 변경
//     - 웹→네이티브 payload: 필드 추가가 required / 기존 필드 타입 변경 / optional→required
//     - 네이티브→웹(result, event): 필드 삭제 / 타입 변경 / required→optional / enum 값 추가
//       (웹이 모르는 enum 값을 받을 수 있으므로. 웹이 대비했다면 x-extensible-enum: true 로 표시)
//     - 웹→네이티브 enum 값 삭제
//   minor: operation 추가, optional 필드 추가 등 나머지 추가
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { buildModel, loadSpec } from './model.mjs'

const basePath = process.argv[2]
if (!basePath) {
  console.error('사용법: node generator/compat.mjs <base-spec.yaml>')
  process.exit(2)
}
const base = buildModel(parse(readFileSync(basePath, 'utf8')))
const head = buildModel(process.argv[3] ? parse(readFileSync(process.argv[3], 'utf8')) : loadSpec())

const typeKey = (ty) => (ty.t === 'array' ? `${typeKey(ty.items)}[]` : ty.t === 'ref' ? ty.name : ty.t)
const typeMap = (m) => new Map(m.types.map((t) => [t.name, t]))
const bt = typeMap(base)
const ht = typeMap(head)
const rawSchema = (m, name) => m.doc.components.schemas[name] ?? {}

const breaking = []
const additions = []

/** 타입 하나를 방향(direction)에 맞게 비교. 'in' = 웹→네이티브, 'out' = 네이티브→웹 */
function compareType(name, direction, where, seen = new Set()) {
  const key = `${name}:${direction}`
  if (seen.has(key)) return
  seen.add(key)
  const b = bt.get(name)
  const h = ht.get(name)
  if (!b) return
  if (!h) return breaking.push(`${where}: 타입 ${name} 삭제`)
  if (b.kind !== h.kind) return breaking.push(`${where}: ${name} 종류 변경 ${b.kind}→${h.kind}`)

  if (b.kind === 'enum') {
    const removed = b.values.filter((v) => !h.values.includes(v))
    const added = h.values.filter((v) => !b.values.includes(v))
    if (direction === 'in' && removed.length) breaking.push(`${where}: ${name} enum 값 삭제 ${removed}`)
    if (direction === 'out' && added.length && !rawSchemaOf(name)['x-extensible-enum']) {
      breaking.push(`${where}: ${name} enum 값 추가 ${added} (구버전 웹이 모르는 값을 받음)`)
    }
    if (direction === 'out' && removed.length) additions.push(`${where}: ${name} enum 값 삭제 ${removed}`)
    if (direction === 'in' && added.length) additions.push(`${where}: ${name} enum 값 추가 ${added}`)
    return
  }

  const bf = new Map(b.fields.map((f) => [f.name, f]))
  const hf = new Map(h.fields.map((f) => [f.name, f]))
  for (const [fname, f] of bf) {
    const g = hf.get(fname)
    if (!g) {
      if (direction === 'out' || f.required) breaking.push(`${where}: ${name}.${fname} 삭제`)
      else additions.push(`${where}: ${name}.${fname} (optional) 삭제`)
      continue
    }
    if (typeKey(f.type) !== typeKey(g.type)) breaking.push(`${where}: ${name}.${fname} 타입 변경 ${typeKey(f.type)}→${typeKey(g.type)}`)
    if (direction === 'in' && !f.required && g.required) breaking.push(`${where}: ${name}.${fname} optional→required`)
    if (direction === 'out' && f.required && !g.required) breaking.push(`${where}: ${name}.${fname} required→optional`)
    const inner = g.type.t === 'array' ? g.type.items : g.type
    if (inner.t === 'ref') compareType(inner.name, direction, where, seen)
  }
  for (const [fname, g] of hf) {
    if (bf.has(fname)) continue
    if (direction === 'in' && g.required) breaking.push(`${where}: ${name}.${fname} required 필드 추가 (구버전 웹은 안 보냄)`)
    else additions.push(`${where}: ${name}.${fname} 추가`)
  }
}
const rawSchemaOf = (name) => rawSchema(head, name)

const bo = new Map(base.operations.map((o) => [o.name, o]))
const ho = new Map(head.operations.map((o) => [o.name, o]))
for (const [name, o] of bo) {
  const n = ho.get(name)
  if (!n) {
    breaking.push(`operation ${name} 삭제`)
    continue
  }
  if (o.kind !== n.kind) {
    breaking.push(`operation ${name} kind 변경 ${o.kind}→${n.kind}`)
    continue
  }
  const payloadDir = o.kind === 'event' ? 'out' : 'in'
  if (o.payload !== n.payload) breaking.push(`${name}: payload 타입 교체 ${o.payload}→${n.payload}`)
  else compareType(o.payload, payloadDir, name)
  if (o.result) {
    if (o.result !== n.result) breaking.push(`${name}: result 타입 교체 ${o.result}→${n.result}`)
    else compareType(o.result, 'out', name)
  }
}
for (const name of ho.keys()) if (!bo.has(name)) additions.push(`operation ${name} 추가`)

const [bMaj, bMin] = base.version.split('.').map(Number)
const [hMaj, hMin] = head.version.split('.').map(Number)
// 0.x 동안은 minor를 major처럼 취급 (semver 관례)
const majorBumped = bMaj === 0 ? hMaj > 0 || hMin > bMin : hMaj > bMaj

console.log(`base v${base.version} → head v${head.version}`)
for (const a of additions) console.log(`  + ${a}`)
for (const b of breaking) console.log(`  ✖ ${b}`)

if (breaking.length && !majorBumped) {
  console.error(`\n✖ 깨지는 변경 ${breaking.length}건 — ${bMaj === 0 ? 'minor(0.x)' : 'major'} 버전을 올리거나, 새 operation으로 추가하세요.`)
  process.exit(1)
}
if (!breaking.length && !additions.length) console.log('  (계약 변경 없음)')
else if (base.version === head.version) {
  console.error(`\n✖ 계약이 바뀌었는데 버전이 그대로(v${head.version})입니다. package.json·info.version을 올리세요.`)
  process.exit(1)
}
console.log(breaking.length ? '✓ 깨지는 변경이 있지만 버전이 올라갔습니다.' : '✓ 하위 호환')
