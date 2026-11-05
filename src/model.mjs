// AsyncAPI 3.0 문서를 코드 생성용 중간 모델(IR)로 바꾼다.
// 지원하는 JSON Schema 범위를 일부러 좁게 잡는다. 범위를 넘으면 조용히 any로 두지 않고 에러를 낸다.
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const KINDS = new Set(['request', 'emit', 'event'])
const PLATFORMS = ['ios', 'android']

export function loadSpec(path) {
  return parse(readFileSync(path, 'utf8'))
}

/** '#/components/schemas/Foo' → 'Foo' */
function refName(ref, prefix) {
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) {
    throw new Error(`지원하지 않는 $ref: ${ref} (기대: ${prefix}<name>)`)
  }
  return ref.slice(prefix.length)
}

function resolvePointer(doc, ref) {
  if (!ref.startsWith('#/')) throw new Error(`외부 $ref는 지원하지 않음: ${ref}`)
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => {
      const k = key.replace(/~1/g, '/').replace(/~0/g, '~')
      if (node == null || !(k in node)) throw new Error(`$ref를 찾을 수 없음: ${ref}`)
      return node[k]
    }, doc)
}

/** 메시지 참조(채널 메시지 → components 메시지 체인)를 따라가서 payload 스키마 이름을 얻는다. */
function payloadSchemaOf(doc, messageRef) {
  let msg = resolvePointer(doc, messageRef)
  while (msg.$ref) msg = resolvePointer(doc, msg.$ref)
  if (!msg.payload?.$ref) {
    throw new Error(`메시지 payload는 components/schemas 를 $ref 해야 함: ${messageRef}`)
  }
  return refName(msg.payload.$ref, '#/components/schemas/')
}

/**
 * 타입 IR
 *  { t: 'ref', name } | { t: 'string', format? } | { t: 'enum', name, values }
 *  { t: 'boolean' } | { t: 'integer' } | { t: 'number' } | { t: 'array', items }
 */
function typeOf(schema, ctxName, inlineEnums) {
  if (schema.$ref) return { t: 'ref', name: refName(schema.$ref, '#/components/schemas/') }
  if (schema.enum) {
    if (schema.type !== 'string') throw new Error(`${ctxName}: string enum만 지원`)
    const e = { t: 'enum', name: ctxName, values: schema.enum, description: schema.description }
    inlineEnums.push(e)
    return { t: 'ref', name: ctxName }
  }
  switch (schema.type) {
    case 'string':
      return { t: 'string', format: schema.format }
    case 'boolean':
    case 'integer':
    case 'number':
      return { t: schema.type }
    case 'array':
      if (!schema.items) throw new Error(`${ctxName}: array에는 items가 필요`)
      return { t: 'array', items: typeOf(schema.items, `${ctxName}Item`, inlineEnums) }
    case 'object':
      throw new Error(`${ctxName}: 인라인 object는 지원하지 않음. components/schemas로 분리하고 $ref 하세요.`)
    default:
      throw new Error(`${ctxName}: 지원하지 않는 타입 ${JSON.stringify(schema.type)}`)
  }
}

const pascal = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** 'Acme WebView Bridge' → 'acme-webview-bridge' / 'AcmeWebviewBridge' */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bridge'
const camelWords = (s) => slug(s).split('-').map(pascal).join('')

/**
 * 산출물 이름 설정. info.x-bridgegen 에 적고, 없으면 title에서 만든다.
 *   npm:     { name }                         예: '@acme/bridge'
 *   android: { groupId, artifactId, package } 예: com.acme / bridge / com.acme.bridge
 *   swift:   { module, accessLevel }          예: AcmeBridge / public
 *   reservedNames: [이미 쓰는 다른 브릿지 이름]
 * 예전 형식 info.x-codegen.{swiftAccessLevel, kotlinPackage} 도 읽는다.
 */
export function resolveConfig(doc) {
  const x = doc.info?.['x-bridgegen'] ?? {}
  const legacy = doc.info?.['x-codegen'] ?? {}
  const base = slug(doc.info?.title ?? 'bridge')
  const pkg = x.android?.package ?? legacy.kotlinPackage ?? `com.example.${base.replace(/-/g, '')}`
  const cfg = {
    npm: { name: x.npm?.name ?? base },
    android: {
      groupId: x.android?.groupId ?? pkg.split('.').slice(0, -1).join('.') ?? 'com.example',
      artifactId: x.android?.artifactId ?? base,
      package: pkg,
      minSdk: x.android?.minSdk ?? 24,
    },
    swift: { module: x.swift?.module ?? camelWords(doc.info?.title ?? 'Bridge'), accessLevel: x.swift?.accessLevel ?? legacy.swiftAccessLevel ?? 'public' },
    reservedNames: x.reservedNames ?? [],
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(cfg.android.package)) throw new Error(`x-bridgegen.android.package 형식이 잘못됨: ${cfg.android.package}`)
  if (!/^[A-Z][A-Za-z0-9]*$/.test(cfg.swift.module)) throw new Error(`x-bridgegen.swift.module 은 UpperCamelCase: ${cfg.swift.module}`)
  if (!['public', 'internal'].includes(cfg.swift.accessLevel)) throw new Error('x-bridgegen.swift.accessLevel 은 public | internal')
  return cfg
}

export function buildModel(doc = loadSpec()) {
  if (doc.asyncapi !== '3.0.0') throw new Error(`asyncapi 3.0.0만 지원 (현재 ${doc.asyncapi})`)

  const version = doc.info.version
  const config = resolveConfig(doc)
  const codegen = { swiftAccessLevel: config.swift.accessLevel, kotlinPackage: config.android.package }

  // ── schemas ──────────────────────────────────────────────
  const types = [] // { kind: 'object'|'enum', name, ... }
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    if (schema['x-codegen-skip']) continue
    if (schema.type === 'string' && schema.enum) {
      types.push({ kind: 'enum', name, values: schema.enum, description: schema.description })
      continue
    }
    if (schema.type !== 'object') throw new Error(`components/schemas/${name}: object 또는 string enum만 지원`)
    const required = new Set(schema.required ?? [])
    const inlineEnums = []
    const fields = Object.entries(schema.properties ?? {}).map(([fname, fschema]) => ({
      name: fname,
      type: typeOf(fschema, name + pascal(fname), inlineEnums),
      required: required.has(fname),
      description: fschema.description,
    }))
    for (const r of required) {
      if (!(r in (schema.properties ?? {}))) throw new Error(`${name}: required '${r}' 에 해당하는 property가 없음`)
    }
    for (const e of inlineEnums) types.push({ kind: 'enum', ...e })
    types.push({ kind: 'object', name, fields, description: schema.description })
  }
  const typeNames = new Set(types.map((t) => t.name))
  for (const t of types) {
    if (t.kind !== 'object') continue
    for (const f of t.fields) {
      const check = (ty) => {
        if (ty.t === 'ref' && !typeNames.has(ty.name)) throw new Error(`${t.name}.${f.name}: 알 수 없는 타입 ${ty.name}`)
        if (ty.t === 'array') check(ty.items)
      }
      check(f.type)
    }
  }

  // ── operations ───────────────────────────────────────────
  const operations = Object.entries(doc.operations ?? {}).map(([name, op]) => {
    const kind = op['x-kind']
    if (!KINDS.has(kind)) throw new Error(`operations/${name}: x-kind는 request|emit|event 중 하나`)
    // 관점은 WebView: request·emit은 웹이 보내고(send), event는 웹이 받는다(receive)
    const expectedAction = kind === 'event' ? 'receive' : 'send'
    if (op.action !== expectedAction) {
      throw new Error(`operations/${name}: x-kind=${kind} 이면 action=${expectedAction} 이어야 함 (현재 ${op.action})`)
    }
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
      throw new Error(`operations/${name}: 이름은 점(.) 없는 lowerCamelCase 한 단어 (예: ping, getAppInfo)`)
    }
    if (/^bridge([A-Z]|$)/.test(name)) throw new Error(`operations/${name}: 'bridge'로 시작하는 이름은 런타임 예약 (예: bridge.hello)`)
    if (!op.messages || op.messages.length !== 1) throw new Error(`operations/${name}: messages는 정확히 1개`)
    const payload = payloadSchemaOf(doc, op.messages[0].$ref)

    let result
    if (kind === 'request') {
      if (!op.reply?.messages?.length) throw new Error(`operations/${name}: request에는 reply가 필요`)
      result = payloadSchemaOf(doc, op.reply.messages[0].$ref)
    } else if (op.reply) {
      throw new Error(`operations/${name}: ${kind}에는 reply가 있으면 안 됨`)
    }

    const since = op['x-since'] ?? {}
    for (const k of Object.keys(since)) {
      if (!PLATFORMS.includes(k)) throw new Error(`operations/${name}: x-since 알 수 없는 플랫폼 ${k}`)
    }
    if (kind !== 'request' && (op['x-idempotent'] != null || op['x-timeout-ms'] != null || op['x-native-errors'])) {
      throw new Error(`operations/${name}: x-idempotent · x-timeout-ms · x-native-errors 는 request에만 씁니다`)
    }
    const timeoutMs = op['x-timeout-ms'] ?? null
    if (timeoutMs != null && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) throw new Error(`operations/${name}: x-timeout-ms는 양의 정수`)
    const nativeCodes = doc.components?.schemas?.NativeErrorCode?.enum ?? []
    const nativeErrors = op['x-native-errors'] ?? []
    for (const c of nativeErrors) {
      if (!nativeCodes.includes(c)) throw new Error(`operations/${name}: x-native-errors ${c} 가 NativeErrorCode enum에 없음`)
    }
    for (const ref of [payload, result].filter(Boolean)) {
      if (!typeNames.has(ref)) throw new Error(`operations/${name}: 스키마 ${ref} 가 생성 대상이 아님`)
    }

    // getAppInfo → getAppInfo (Swift · Kotlin 메서드) / GetAppInfo (타입 · enum case)
    const camel = name
    return {
      name,
      kind,
      camel,
      pascal: pascal(camel),
      summary: op.summary ?? '',
      description: op.description ?? '',
      since: Object.fromEntries(PLATFORMS.map((p) => [p, since[p] != null ? String(since[p]) : null])),
      payload,
      result,
      idempotent: kind === 'request' ? op['x-idempotent'] === true : false,
      timeoutMs,
      nativeErrors,
    }
  })

  const model = { version, title: doc.info.title, description: doc.info.description, config, codegen, types, operations, doc }
  assertNoReservedNames(model)
  return model
}

/**
 * 이미 쓰고 있는 다른 브릿지(예: 이전 세대 전역 콜백)의 이름과 겹치지 않는지 확인한다.
 * info.x-bridgegen.reservedNames 에 적은 이름은 operation 이름으로 쓸 수 없다.
 */
export function assertNoReservedNames(model) {
  const reserved = new Set(model.config.reservedNames ?? [])
  const clashes = model.operations.filter((o) => reserved.has(o.name))
  if (clashes.length) {
    throw new Error(clashes.map((o) => `operations/${o.name}: x-bridgegen.reservedNames 에 있는 이름입니다. 다른 이름을 쓰세요.`).join('\n'))
  }
}

export const isEmpty = (model, typeName) => {
  const t = model.types.find((x) => x.name === typeName)
  return t?.kind === 'object' && t.fields.length === 0
}
