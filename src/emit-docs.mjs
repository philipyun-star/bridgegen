// 의존성 없는 단일 HTML 문서 (Swagger형 operation 목록 + 왼쪽 목차).
// 배지: bridge.request = REQUEST, bridge.emit = SEND, bridge.on = RECEIVE.
import { isEmpty } from './model.mjs'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const inline = (s) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')

/** 아주 작은 markdown: ## 제목, - 목록, `code`, **bold** */
function md(text) {
  const out = []
  let list = false
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd()
    const li = line.match(/^\s*-\s+(.*)/)
    if (li) {
      if (!list) out.push('<ul>'), (list = true)
      out.push(`<li>${inline(li[1])}</li>`)
      continue
    }
    if (list) out.push('</ul>'), (list = false)
    if (!line.trim()) continue
    const h = line.match(/^(#{2,4})\s+(.*)/)
    if (h) out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`)
    else out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push('</ul>')
  return out.join('\n')
}

const findType = (model, name) => model.types.find((x) => x.name === name)

function typeLabel(model, ty) {
  switch (ty.t) {
    case 'ref': {
      const t = findType(model, ty.name)
      return t?.kind === 'enum' && t.values.length <= 4 ? t.values.map((v) => JSON.stringify(v)).join(' | ') : ty.name
    }
    case 'array':
      return `${typeLabel(model, ty.items)}[]`
    case 'string':
      return ty.format ? `string (${ty.format})` : 'string'
    default:
      return ty.t
  }
}

/** 중첩 객체 필드를 a.b.c 형태로 평평하게 */
function rows(model, typeName, prefix = '', seen = new Set()) {
  const t = findType(model, typeName)
  if (!t || t.kind !== 'object' || seen.has(typeName)) return []
  seen = new Set(seen).add(typeName)
  return t.fields.flatMap((f) => {
    const inner = f.type.t === 'array' ? f.type.items : f.type
    const child = inner.t === 'ref' ? rows(model, inner.name, `${prefix}${f.name}${f.type.t === 'array' ? '[]' : ''}.`, seen) : []
    return [{ name: prefix + f.name, type: typeLabel(model, f.type), required: f.required, desc: f.description }, ...child]
  })
}

function fieldTable(model, typeName) {
  const r = rows(model, typeName)
  return `<div class="table-wrap"><table>
<tr><th>Name</th><th>Type</th><th>Description</th></tr>
${r.map((x) => `<tr><td class="f">${esc(x.name)}${x.required ? '<span class="req">*</span>' : ''}</td><td class="t">${esc(x.type)}</td><td>${inline(x.desc ?? '')}</td></tr>`).join('\n')}
</table></div>`
}

function payloadTable(model, typeName) {
  const t = findType(model, typeName)
  if (t.kind === 'object' && t.fields.length === 0) return '<p class="empty">없음 (<code>{}</code>)</p>'
  const caption = `<p class="tname"><a href="#type-${esc(typeName)}">${esc(typeName)}</a>${t.description ? ` <span>· ${inline(t.description)}</span>` : ''}</p>`
  return caption + fieldTable(model, typeName)
}

function sampleValue(model, ty, depth = 0) {
  if (depth > 4) return null
  switch (ty.t) {
    case 'string':
      return ty.format === 'uri' ? 'https://example.com/path' : 'string'
    case 'boolean':
      return true
    case 'integer':
      return 1
    case 'number':
      return 1.5
    case 'array':
      return [sampleValue(model, ty.items, depth + 1)]
    case 'ref':
      return sampleOf(model, ty.name, depth + 1)
  }
}

function sampleOf(model, typeName, depth = 0) {
  const t = findType(model, typeName)
  if (t.kind === 'enum') return t.values[0]
  return Object.fromEntries(t.fields.map((f) => [f.name, sampleValue(model, f.type, depth)]))
}

const json = (v) => esc(JSON.stringify(v))

const KIND = {
  request: { label: 'REQUEST', api: 'bridge.request', dir: 'Web → Native · 응답 있음 (RPC)' },
  emit: { label: 'SEND', api: 'bridge.emit', dir: 'Web → Native · 응답 없음' },
  event: { label: 'RECEIVE', api: 'bridge.on', dir: 'Native → Web · 푸시 이벤트' },
}
const KIND_ORDER = ['request', 'emit', 'event']

/** Bridge Core가 소유하는 오류 코드의 뜻. */
const ERROR_INFO = {
  UNAVAILABLE: ['Native 브릿지가 없음 (일반 브라우저 등)', 'Adapter', '안 함', '앱에서 열어 달라는 안내'],
  SEND_FAILED: ['전송 호출 자체가 실패', 'Adapter · Core', '읽기 요청만', '재시도 버튼'],
  TIMEOUT: ['제한 시간 안에 응답 없음. 늦게 온 응답은 무시하고 기록', 'Core', '읽기 요청만', '자동 재시도 후 안내'],
  NATIVE_ERROR: ['Native가 처리에 실패. 원인은 details.code', 'Handler → Core', 'retryable에 따름', '도메인 메시지와 복구 UI'],
  INVALID_RESPONSE: ['수신 envelope의 형식 · version · source가 잘못됨. reject하지 않고 기록만', 'Core', '해당 없음', '보여주지 않음'],
  UNSUPPORTED_VERSION: ['앱이 그 method · event나 envelope version을 지원하지 않음', 'Core (보내기 전) · Native Router', '안 함', '앱 업데이트 안내'],
  ABORTED: ['화면 이탈, Provider unmount', 'Provider · Core', '안 함', '보여주지 않음'],
}
const NATIVE_INFO = {
  METHOD_NOT_ALLOWED: 'Router · 화이트리스트에 없는 method',
  INVALID_PARAMS: 'Router · params가 계약과 다름',
  NOT_IMPLEMENTED: 'Router · Handler가 없는 method',
  INTERNAL: 'Router · Handler에서 예상하지 못한 오류',
}

function webUsage(o, empty) {
  if (o.kind === 'request') return `const result = await bridge.request('${o.name}'${empty ? '' : ', params'})`
  if (o.kind === 'emit') return `bridge.emit('${o.name}'${empty ? '' : ', payload'})`
  return `const off = bridge.on('${o.name}', (payload) => { ... })`
}

function nativeUsage(model, o, platform) {
  if (o.kind === 'event') {
    if (platform === 'ios') return o.payloadEmpty ? `router.send(.${o.camel})` : `router.send(.${o.camel}(${o.payload}(...)))`
    return o.payloadEmpty ? `router.send(BridgeEvent.${o.pascal})` : `router.send(BridgeEvent.${o.pascal}(${o.payload}(...)))`
  }
  const params = o.payloadEmpty ? '' : platform === 'ios' ? `_ params: ${o.payload}` : `params: ${o.payload}`
  const ret = o.result && !isEmpty(model, o.result) ? o.result : null
  const head = '// BridgeMethodHandling\n'
  return (
    head +
    (platform === 'ios'
      ? `func ${o.camel}(${params}) async throws${ret ? ` -> ${ret}` : ''}`
      : `override suspend fun ${o.camel}(${params})${ret ? `: ${ret}` : ''}`)
  )
}

function envelopeOf(model, o) {
  const payload = sampleOf(model, o.payload)
  if (o.kind === 'request') return { type: 'rpc_request', id: 'b1f3…', version: 1, target: 'native', method: o.name, params: payload }
  if (o.kind === 'emit') return { type: 'event', version: 1, source: 'web', target: 'native', event: o.name, payload }
  return { type: 'event', version: 1, source: 'native', event: o.name, payload }
}

function operationBlock(model, o) {
  o.payloadEmpty = isEmpty(model, o.payload)
  const platforms = ['ios', 'android'].filter((p) => o.since[p])
  const plat = platforms.length === 2 ? 'both' : platforms[0] ?? 'none'
  const flags = [
    plat === 'ios' && '<span class="chip">iOS 전용</span>',
    plat === 'android' && '<span class="chip">Android 전용</span>',
    plat === 'none' && '<span class="chip warn">미구현</span>',
    o.idempotent && '<span class="chip">idempotent</span>',
    platforms.length && `<span class="chip">${platforms.map((p) => `${p === 'ios' ? 'iOS' : 'Android'}: ${esc(o.since[p])}`).join(', ')}</span>`,
  ]
    .filter(Boolean)
    .join('')

  const since = (p) => (o.since[p] ? `${esc(o.since[p])}+` : '<span class="empty">미지원</span>')
  const meta = [
    ['방향', `${KIND[o.kind].dir} · <code>${KIND[o.kind].api}</code>`],
    ['iOS', since('ios')],
    ['Android', since('android')],
    o.kind !== 'event' && ['지원 확인', `<code>bridge.isSupported('${esc(o.name)}')</code> · 없으면 <code>UNSUPPORTED_VERSION</code>`],
    o.kind === 'request' && ['자동 재시도', o.idempotent ? '허용 (읽기 전용, idempotent)' : '안 함'],
    o.kind === 'request' && ['timeout', o.timeoutMs ? `${o.timeoutMs}ms` : '기본값 (10초)'],
    o.nativeErrors.length && ['Native 오류 코드', `${o.nativeErrors.map((c) => `<code>${esc(c)}</code>`).join(', ')} (<code>NATIVE_ERROR</code>의 <code>details.code</code>)`],
  ].filter(Boolean)

  const reply = o.result
    ? `<h4>응답 · result</h4><div class="reply">
<p class="src"><code>rpc_response</code>가 같은 <code>id</code>로 <code>window.__receiveBridgeMessage</code>에 들어옵니다. 실패하면 <code>result</code> 대신 <code>error</code>(<a href="#type-BridgeError">BridgeError</a>)가 옵니다.</p>
${payloadTable(model, o.result)}
</div>`
    : ''

  const wire = `<h4>메시지 형식</h4><div class="wire">
<div><span>${o.kind === 'event' ? 'Native →' : 'Web →'}</span><pre>${json(envelopeOf(model, o))}</pre></div>
${o.result ? `<div><span>← 응답</span><pre>${json({ type: 'rpc_response', id: 'b1f3…', version: 1, source: 'native', method: o.name, result: sampleOf(model, o.result) })}</pre></div>` : ''}
${o.nativeErrors.length ? `<div><span>← 실패</span><pre>${json({ type: 'rpc_response', id: 'b1f3…', version: 1, source: 'native', method: o.name, error: { code: 'NATIVE_ERROR', message: '…', retryable: false, details: { code: o.nativeErrors[0] } } })}</pre></div>` : ''}
</div>`

  const usage = `<h4>사용</h4><div class="wire">
<div><span>Web</span><pre>${esc(webUsage(o, o.payloadEmpty))}</pre></div>
<div><span>iOS</span><pre>${esc(nativeUsage(model, o, 'ios'))}</pre></div>
<div><span>Android</span><pre>${esc(nativeUsage(model, o, 'android'))}</pre></div>
</div>`

  const search = `${o.name} ${o.summary} ${o.description}`.toLowerCase()
  return `<details class="op ${o.kind}" id="op-${esc(o.name)}" data-kind="${o.kind}" data-plat="${plat}" data-search="${esc(search)}">
<summary>
  <span class="badge">${KIND[o.kind].label}</span>
  <span class="name">${esc(o.name)}</span>
  <span class="summary">${inline(o.summary)}</span>
  <span class="flags">${flags}</span>
</summary>
<div class="body">
  ${o.summary ? `<p class="desc">${inline(o.summary)}</p>` : ''}
  ${o.description ? md(o.description) : ''}
  <dl class="meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
  <h4>${o.kind === 'request' ? 'params' : o.kind === 'emit' ? 'payload (웹 → 네이티브)' : 'payload (네이티브 → 웹)'}</h4>
  ${payloadTable(model, o.payload)}
  ${reply}
  ${wire}
  ${usage}
</div>
</details>`
}

function typeBlock(model, t) {
  const body =
    t.kind === 'enum'
      ? `<p class="enum">${t.values.map((v) => `<code>${esc(v)}</code>`).join(' ')}</p>`
      : t.fields.length
        ? fieldTable(model, t.name)
        : '<p class="empty"><code>{}</code></p>'
  return `<details class="op type" id="type-${esc(t.name)}">
<summary><span class="badge">${t.kind === 'enum' ? 'ENUM' : 'SCHEMA'}</span><span class="name">${esc(t.name)}</span><span class="summary">${inline(String(t.description ?? '').split('\n')[0])}</span></summary>
<div class="body">${t.description ? md(t.description) : ''}${body}</div>
</details>`
}

function envelopeSection(model) {
  const schemas = model.doc.components.schemas
  const table = (name) => {
    const s = schemas[name]
    const req = new Set(s.required ?? [])
    return `<div class="table-wrap"><table><tr><th>Name</th><th>Type</th><th>Description</th></tr>${Object.entries(s.properties)
      .map(([k, v]) => {
        const type = v.const !== undefined ? JSON.stringify(v.const) : v.enum ? v.enum.map((x) => JSON.stringify(x)).join(' | ') : v.$ref ? v.$ref.split('/').pop() : v.type ?? 'unknown'
        return `<tr><td class="f">${esc(k)}${req.has(k) ? '<span class="req">*</span>' : ''}</td><td class="t">${v.$ref ? `<a href="#type-${esc(type)}">${esc(type)}</a>` : esc(type)}</td><td>${inline(v.description ?? '')}</td></tr>`
      })
      .join('')}</table></div>`
  }
  return `<section id="envelope"><h2 class="sec">메시지 형식</h2>
<p>JSON-RPC 2.0을 그대로 쓰지 않고 request · response · notification 개념만 가져온 envelope입니다. 종류는 <code>type</code>으로 나눕니다.</p>
<div class="env"><h3><span class="mini request">rpc_request</span> Web → Native</h3><p class="muted">${inline(schemas.RpcRequest.description)}</p>${table('RpcRequest')}</div>
<div class="env"><h3><span class="mini event">rpc_response</span> Native → Web</h3><p class="muted">${inline(schemas.RpcResponse.description)}</p>${table('RpcResponse')}</div>
<div class="env"><h3><span class="mini emit">event</span> 양방향</h3><p class="muted">${inline(schemas.EventEnvelope.description)}</p>${table('EventEnvelope')}</div>
</section>`
}

function errorSection(model) {
  const codes = findType(model, 'BridgeErrorCode')?.values ?? []
  const native = findType(model, 'NativeErrorCode')?.values ?? []
  const byOp = (c) => model.operations.filter((o) => o.nativeErrors.includes(c)).map((o) => `<a href="#op-${esc(o.name)}"><code>${esc(o.name)}</code></a>`)
  return `<section id="errors"><h2 class="sec">오류 코드</h2>
<p>모든 실패는 <a href="#type-BridgeError">BridgeError</a> <code>{ code, message, retryable, details }</code>로 정규화됩니다. Native는 <code>NATIVE_ERROR</code>와 <code>UNSUPPORTED_VERSION</code>만 보내고 나머지는 Bridge Core가 만듭니다.
허용되지 않은 origin이나 iframe에서 온 요청은 Native Router가 응답 없이 버립니다. Web은 <code>TIMEOUT</code>까지 기다립니다.</p>
<div class="table-wrap"><table><tr><th>code</th><th>언제</th><th>감지하는 곳</th><th>자동 재시도</th><th>화면</th></tr>
${codes.map((c) => { const i = ERROR_INFO[c] ?? ['', '', '', '']; return `<tr><td class="f">${esc(c)}</td><td>${esc(i[0])}</td><td>${esc(i[1])}</td><td>${esc(i[2])}</td><td>${esc(i[3])}</td></tr>` }).join('\n')}
</table></div>
<h3>NATIVE_ERROR의 details.code</h3>
<div class="table-wrap"><table><tr><th>details.code</th><th>뜻</th></tr>
${native.map((c) => `<tr><td class="f">${esc(c)}</td><td>${NATIVE_INFO[c] ? esc(NATIVE_INFO[c]) : `Handler · ${byOp(c).join(', ') || '도메인 오류'}`}</td></tr>`).join('\n')}
</table></div>
</section>`
}


function sidebar(model) {
  const ops = (k) =>
    model.operations
      .filter((o) => o.kind === k)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => `<li><a href="#op-${esc(o.name)}"><span class="mini ${k}">${KIND[k].label}</span><span class="nm">${esc(o.name)}</span></a></li>`)
      .join('')
  return `<nav class="toc" aria-label="목차">
<details open><summary>목차</summary>
<div class="toc-title">${esc(model.title)}<span>contract ${esc(model.version)}</span></div>
<ol>
  <li><a href="#intro">소개</a></li>
  <li><a href="#servers">전송 방식</a>
    <ol>${Object.keys(model.doc.servers ?? {}).map((k) => `<li><a href="#server-${esc(k)}">${k === 'ios' ? 'iOS' : k === 'android' ? 'Android' : esc(k)}</a></li>`).join('')}</ol></li>
  <li><a href="#envelope">메시지 형식</a></li>
  <li><a href="#errors">오류 코드</a></li>
  <li><a href="#operations">Operations</a>
    ${KIND_ORDER.map((k) => `<ol class="ops">${ops(k)}</ol>`).join('')}</li>
  <li><a href="#schemas">Schemas</a>
    <ol class="ops">${model.types.map((t) => `<li><a href="#type-${esc(t.name)}"><span class="nm">${esc(t.name)}</span></a></li>`).join('')}</ol></li>
</ol>
</details>
</nav>`
}

export function emitDocs(model) {
  const servers = Object.entries(model.doc.servers ?? {})
  const counts = Object.fromEntries(KIND_ORDER.map((k) => [k, model.operations.filter((o) => o.kind === k).length]))
  const [intro, ...rest] = String(model.description ?? '').split('\n\n')
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.title)} ${esc(model.version)}</title>
<style>
:root{--bg:#fff;--fg:#3b4151;--muted:#7a8394;--line:#e3e6ea;--code-bg:#f5f6f8;--side:#f7f8fa;
--emit:#49cc90;--emit-bg:rgba(73,204,144,.08);--request:#fca130;--request-bg:rgba(252,161,48,.08);
--event:#61affe;--event-bg:rgba(97,175,254,.08);--schema:#9aa1ad;--schema-bg:rgba(154,161,173,.06);
--warn:#b45309;--warn-bg:#fef3c7;--chip-bg:#eef1f5;--type:#8a4baf;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#d6dae1;--muted:#8b93a3;--line:#2a2e36;--code-bg:#1f232a;--side:#1b1e24;
--emit-bg:rgba(73,204,144,.1);--request-bg:rgba(252,161,48,.1);--event-bg:rgba(97,175,254,.1);--schema-bg:rgba(154,161,173,.08);
--warn:#fbbf24;--warn-bg:rgba(251,191,36,.12);--chip-bg:#262a32;--type:#c792ea;color-scheme:dark}}
*{box-sizing:border-box}
html{scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Pretendard','Segoe UI',sans-serif}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
a{color:var(--event)}
code,pre{font-family:var(--mono);font-size:12.5px}
:not(pre)>code{background:var(--code-bg);padding:1px 5px;border-radius:4px}
.muted{color:var(--muted)}

/* 목차 */
.toc{position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;background:var(--side);border-right:1px solid var(--line);padding:20px 14px 40px;font-size:13px}
.toc>details>summary{display:none}
.toc-title{font-weight:700;font-size:15px;margin:0 6px 14px}.toc-title span{display:block;font-weight:400;font-size:12px;color:var(--muted)}
.toc ol{list-style:none;margin:0;padding:0}
.toc>details>ol>li{margin-bottom:6px}
.toc>details>ol>li>a{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.toc ol ol{margin:4px 0 6px}
.toc a{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;color:var(--fg);text-decoration:none;min-width:0}
.toc a:hover{background:var(--chip-bg)}
.toc a.on{background:var(--chip-bg);font-weight:600}
.toc .nm{font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini{flex:none;display:inline-block;min-width:58px;text-align:center;color:#fff;font:700 10px/1 var(--mono);padding:4px 0;border-radius:3px}
.mini.request{background:var(--request)}.mini.emit{background:var(--emit)}.mini.event{background:var(--event)}

.wrap{max-width:1100px;width:100%;margin:0 auto;padding:32px 24px 80px}
header h1{margin:0;font-size:32px;font-weight:700;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ver,.spec{font-size:12px;font-weight:600;color:#fff;padding:2px 8px;border-radius:10px}
.ver{background:#89bf04}.spec{background:#7d8492}
header .links{margin-top:6px;font-size:13px}
.intro{color:var(--muted);margin-top:8px}.intro p{margin:4px 0}
.more{margin-top:10px}.more>summary{cursor:pointer;color:var(--muted);font-size:13px}.more ul{margin:6px 0;padding-left:20px}.more h3{font-size:14px;margin:14px 0 4px}
.servers{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
.server{flex:1 1 280px;min-width:0;border:1px solid var(--line);border-radius:6px;padding:12px 14px;scroll-margin-top:16px}
.server code,.body :not(pre)>code,.intro code,.more code{overflow-wrap:anywhere}
.server b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:4px}
.server .d{color:var(--muted)}.server .d p{margin:4px 0 0}
h2.sec{font-size:20px;margin:40px 0 12px;padding-top:4px}
section{scroll-margin-top:16px}
.env{border:1px solid var(--line);border-radius:6px;padding:4px 14px 12px;margin:10px 0}
.env h3{font-size:14px;display:flex;align-items:center;gap:8px;margin:12px 0 4px}
.env .mini{min-width:96px}
.toolbar{position:sticky;top:0;z-index:5;background:var(--bg);padding:14px 0;border-bottom:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.toolbar input{flex:1 1 240px;padding:8px 12px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.seg button{border:0;background:transparent;color:var(--fg);padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.count{color:var(--muted);font-size:13px}
#list{margin-top:20px}
.op{border:1px solid;border-radius:6px;margin-bottom:10px;overflow:hidden;scroll-margin-top:80px}
.op.emit{border-color:var(--emit);background:var(--emit-bg)}
.op.request{border-color:var(--request);background:var(--request-bg)}
.op.event{border-color:var(--event);background:var(--event-bg)}
.op.type{border-color:var(--line);background:var(--schema-bg);scroll-margin-top:16px}
.op>summary{list-style:none;display:flex;align-items:center;gap:12px;padding:7px 10px;cursor:pointer}
.op>summary::-webkit-details-marker{display:none}
.badge{flex:none;min-width:84px;text-align:center;color:#fff;font-weight:700;font-size:13px;padding:6px 0;border-radius:3px;letter-spacing:.02em}
.emit .badge{background:var(--emit)}.request .badge{background:var(--request)}.event .badge{background:var(--event)}.type .badge{background:var(--schema)}
.name{font-family:var(--mono);font-weight:600;font-size:15px;word-break:break-all}
.summary{color:var(--muted);font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.flags{display:flex;gap:6px;flex:none}
.chip{font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;background:var(--chip-bg);color:var(--fg);white-space:nowrap}
.chip.warn{background:var(--warn-bg);color:var(--warn)}
.body{background:var(--bg);border-top:1px solid var(--line);padding:4px 18px 18px}
.body h4{margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.body ul{margin:6px 0;padding-left:20px}
.desc{white-space:pre-wrap;margin:12px 0 0}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:14px 0 0}
dl.meta dt{color:var(--muted)}dl.meta dd{margin:0}
.tname{margin:0 0 6px;font-family:var(--mono);font-size:12.5px;font-weight:600}.tname span{font-family:inherit;font-weight:400;color:var(--muted)}
.enum code{display:inline-block;margin:2px 2px 2px 0}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--muted);font-weight:600}
td.f{font-family:var(--mono);font-weight:600;white-space:nowrap}
td.f .req{color:#f93e3e;font-size:11px;margin-left:4px}
td.t{font-family:var(--mono);color:var(--type);white-space:nowrap}
.empty{color:var(--muted);font-style:italic}
.table-wrap{overflow-x:auto}
.wire{display:grid;gap:8px}
.wire div{display:grid;grid-template-columns:70px 1fr;gap:8px;align-items:start}
.wire span{font-size:12px;font-weight:600;color:var(--muted);padding-top:9px}
pre{margin:0;background:#333842;color:#e6e9ef;padding:9px 12px;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
.reply{border-left:3px solid var(--event);padding:2px 0 2px 12px}
.reply .src{color:var(--muted);font-size:12px;margin:0 0 8px}
.nores{color:var(--muted);padding:30px 0;text-align:center}
@media (max-width:900px){
  .layout{display:block}
  .toc{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:10px 16px}
  .toc>details>summary{display:block;cursor:pointer;font-weight:600;padding:6px 0}
  .wrap{padding:24px 16px 80px}
}
@media (max-width:640px){.summary,.flags{display:none}.badge{min-width:72px;font-size:12px}.wire div{grid-template-columns:1fr}.wire span{padding-top:0}}
</style>
</head>
<body>
<div class="layout">
${sidebar(model)}
<div class="wrap">
<header id="intro">
  <h1>${esc(model.title)} <span class="ver">${esc(model.version)}</span> <span class="spec">AsyncAPI ${esc(model.doc.asyncapi)}</span></h1>
  <div class="links"><a href="./asyncapi.yaml">asyncapi.yaml</a></div>
  <div class="intro">${md(intro)}</div>
  ${rest.length ? `<details class="more" open><summary>자세히</summary>${md(rest.join('\n\n'))}</details>` : ''}
</header>

<section id="servers"><h2 class="sec">전송 방식</h2>
<div class="servers">
${servers.map(([k, s]) => `<div class="server" id="server-${esc(k)}"><b>${k === 'ios' ? 'iOS' : k === 'android' ? 'Android' : esc(k)} · ${esc(s.protocol)}</b><code>${esc(s.host)}</code><div class="d">${md(s.description)}</div></div>`).join('\n')}
</div>
</section>

${envelopeSection(model)}

${errorSection(model)}

<section id="operations"><h2 class="sec">Operations</h2>
<div class="toolbar">
  <input id="q" type="search" placeholder="이름·설명 검색" aria-label="operation 검색">
  <div class="seg" id="kind">
    <button data-v="all" aria-pressed="true">전체</button>
    <button data-v="request" aria-pressed="false">REQUEST ${counts.request}</button>
    <button data-v="emit" aria-pressed="false">SEND ${counts.emit}</button>
    <button data-v="event" aria-pressed="false">RECEIVE ${counts.event}</button>
  </div>
  <div class="seg" id="plat">
    <button data-v="all" aria-pressed="true">전 플랫폼</button>
    <button data-v="ios" aria-pressed="false">iOS 전용</button>
    <button data-v="android" aria-pressed="false">Android 전용</button>
  </div>
  <span class="count" id="count"></span>
</div>
<div id="list">
${KIND_ORDER.flatMap((k) =>
  model.operations
    .filter((o) => o.kind === k)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((o) => operationBlock(model, o)),
).join('\n')}
<p class="nores" id="nores" hidden>조건에 맞는 operation이 없습니다</p>
</div>
</section>

<section id="schemas"><h2 class="sec">Schemas</h2>
${model.types.map((t) => typeBlock(model, t)).join('\n')}
</section>
</div>
</div>
<script>
(() => {
  const state = { q: '', kind: 'all', plat: 'all' }
  const ops = [...document.querySelectorAll('#list .op')]
  const render = () => {
    const q = state.q.trim().toLowerCase()
    let n = 0
    for (const el of ops) {
      const show = (state.kind === 'all' || el.dataset.kind === state.kind)
        && (state.plat === 'all' || el.dataset.plat === state.plat)
        && (!q || el.dataset.search.includes(q))
      el.hidden = !show
      if (show) n++
    }
    document.getElementById('count').textContent = n + ' / ' + ops.length
    document.getElementById('nores').hidden = n > 0
  }
  document.getElementById('q').addEventListener('input', (e) => { state.q = e.target.value; render() })
  for (const key of ['kind', 'plat']) {
    document.getElementById(key).addEventListener('click', (e) => {
      const b = e.target.closest('button')
      if (!b) return
      state[key] = b.dataset.v
      for (const x of b.parentElement.children) x.setAttribute('aria-pressed', String(x === b))
      render()
    })
  }
  render()

  // 좁은 화면에서는 목차를 접어 두고, 목차에서 고르면 다시 접는다
  const toc = document.querySelector('.toc > details')
  const narrow = matchMedia('(max-width: 900px)')
  if (narrow.matches) toc.open = false
  toc.addEventListener('click', (e) => { if (narrow.matches && e.target.closest('a')) toc.open = false })

  // 목차에서 고르면 그 operation · schema를 펼친다. 필터에 가려져 있으면 필터를 푼다.
  const openHash = () => {
    const el = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)))
    if (!el) return
    if (el.hidden) {
      state.q = ''; state.kind = 'all'; state.plat = 'all'
      document.getElementById('q').value = ''
      for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.v === 'all'))
      render()
    }
    if (el.tagName === 'DETAILS') el.open = true
    el.scrollIntoView({ block: 'start' })
  }
  addEventListener('hashchange', openHash)
  openHash()

  // 지금 보고 있는 위치를 목차에 표시
  const links = new Map([...document.querySelectorAll('.toc a')].map((a) => [decodeURIComponent(a.getAttribute('href').slice(1)), a]))
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        for (const a of links.values()) a.classList.remove('on')
        links.get(e.target.id)?.classList.add('on')
      }
    }, { rootMargin: '0px 0px -75% 0px' })
    for (const id of links.keys()) { const el = document.getElementById(id); if (el) io.observe(el) }
  }
})()
</script>
</body>
</html>
`
}
