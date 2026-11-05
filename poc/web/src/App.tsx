import { useEffect, useState, useSyncExternalStore } from 'react'
import { BRIDGE_CONTRACT_VERSION, isBridgeError } from '@example/ping-bridge'
import { bridge, logStore, receivedStore, type LogEntry } from './bridge'
import type { Badge, CheckResult } from './checks'

type Outcome = { ok: boolean; text: string; ms: number }

function useStore<T>(store: { get: () => T; subscribe: (l: () => void) => () => void }) {
  return useSyncExternalStore(store.subscribe, store.get)
}

const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

export function App({ checks }: { checks: Promise<{ pass: boolean; results: CheckResult[] }> }) {
  const [auto, setAuto] = useState<{ pass: boolean; results: CheckResult[] } | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const [n, setN] = useState(1)
  const received = useStore(receivedStore)
  const log = useStore(logStore)

  useEffect(() => {
    checks.then(setAuto)
  }, [checks])

  // 버튼 하나 = bridge 호출 하나. REQUEST는 응답(또는 BridgeError)을, SEND는 보냈는지(boolean)만 보여준다.
  const run = async (key: string, fn: () => unknown) => {
    const t = performance.now()
    try {
      const r = await fn()
      setOutcomes((s) => ({ ...s, [key]: { ok: true, text: fmt(r), ms: Math.round(performance.now() - t) } }))
    } catch (e) {
      const text = isBridgeError(e) ? `${e.code} ${fmt(e.details ?? '')} — ${e.message}` : String(e)
      setOutcomes((s) => ({ ...s, [key]: { ok: false, text, ms: Math.round(performance.now() - t) } }))
    }
  }

  const actions: { key: string; badge: Badge; label: string; code: string; fn: () => unknown }[] = [
    { key: 'ping', badge: 'REQUEST', label: "ping('hello')", code: "await bridge.request('ping', { message: 'hello' })", fn: () => bridge.request('ping', { message: 'hello' }) },
    { key: 'reject', badge: 'REQUEST', label: "ping('reject')", code: "await bridge.request('ping', { message: 'reject' })  // Native가 PING_REJECTED로 거절", fn: () => bridge.request('ping', { message: 'reject' }) },
    { key: 'reset', badge: 'REQUEST', label: 'resetPing', code: "await bridge.request('resetPing')  // 값 없이 완료만 확인", fn: () => bridge.request('resetPing') },
    {
      key: 'log', badge: 'SEND', label: `logPing('from web #${n}')`, code: `bridge.emit('logPing', { message: 'from web #${n}' })  // 응답 없음`,
      fn: () => {
        setN((x) => x + 1)
        return bridge.emit('logPing', { message: `from web #${n}` })
      },
    },
    { key: 'clear', badge: 'SEND', label: 'clearPingLog', code: "bridge.emit('clearPingLog')", fn: () => bridge.emit('clearPingLog') },
  ]

  return (
    <main>
      <header>
        <h1>bridgegen PoC <span className="tag">React</span></h1>
        <div className="sub">
          contract {BRIDGE_CONTRACT_VERSION} · adapter {bridge.platform ?? 'none'} · app {bridge.capabilities?.appVersion ?? '-'}
          {auto && <b className={auto.pass ? 'pass' : 'fail'}> · 자동 검사 {document.title}</b>}
        </div>
      </header>

      <section>
        <h2>Web → Native <small>버튼을 누르면 실제 Native Handler가 처리합니다</small></h2>
        {actions.map((a) => {
          const o = outcomes[a.key]
          return (
            <div className="card" key={a.key}>
              <div className="row">
                <b className={`badge ${a.badge}`}>{a.badge}</b>
                <button onClick={() => run(a.key, a.fn)}>{a.label}</button>
              </div>
              <code className="src">{a.code}</code>
              {o && <code className={o.ok ? 'res ok' : 'res ng'}>{o.ok ? '✓' : '✗'} {o.text} <i>({o.ms}ms)</i></code>}
            </div>
          )
        })}
      </section>

      <section>
        <h2>Native → Web <small>앱 하단의 <u>네이티브 버튼</u>을 눌러보세요</small></h2>
        <div className="card">
          <div className="row"><b className="badge RECEIVE">RECEIVE</b><code>bridge.on('nativePing' | 'nativePingStopped', cb)</code></div>
          {received.length === 0 ? <div className="empty">아직 받은 이벤트 없음</div> : (
            <ul className="recv">
              {[...received].reverse().map((r) => (
                <li key={r.id}><i>+{r.ms}ms</i> <b>{r.name}</b> {fmt(r.payload)}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h2>메시지 로그 <small>→ Web→Native · ← Native→Web (envelope 원문, 최신이 위)</small>
          <button className="mini" onClick={() => logStore.set([])}>지우기</button>
        </h2>
        <div id="log">
          {log.length === 0 && <div className="empty">비어 있음</div>}
          {[...log].reverse().map((e: LogEntry) => (
            <div key={e.id}>
              <span className="t">+{e.ms}ms</span> <span className={e.dir}>{e.dir === 'out' ? '→' : '←'}</span> {fmt(e.env)}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>자동 검사 <small>페이지 로드 시 한 번 실행 (poc/run.sh가 결과를 읽음)</small></h2>
        {!auto ? <div className="empty">RUNNING…</div> : (
          <ol className="checks">
            {auto.results.map((r, i) => (
              <li key={i}><b className={`badge ${r.badge}`}>{r.badge}</b><span className={r.ok ? 'ok' : 'ng'}>{r.name}</span></li>
            ))}
          </ol>
        )}
      </section>
    </main>
  )
}
