#!/usr/bin/env node
// bridgegen — AsyncAPI 3.0 spec 하나에서 WebView 브릿지의 Web(npm) · iOS(Swift Package) · Android(Maven) 패키지를 만든다.
import { readFileSync, existsSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { buildModel } from './model.mjs'
import { buildAndroid, buildDocs, buildIos, buildJs } from './targets.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const HELP = `bridgegen ${VERSION}

사용법
  bridgegen build <spec.yaml> [--out <dir>] [--targets js,ios,android,docs]
                  [--no-pack] [--no-android-publish] [--verify-ios]
  bridgegen validate <spec.yaml>
  bridgegen compat <base-spec.yaml> <head-spec.yaml>
  bridgegen init [dir]

build 산출물 (<out> 기본값: ./bridgegen-out)
  js/        npm 패키지 소스 + dist,  <name>-<version>.tgz (npm install ./파일.tgz)
  ios/       Swift Package (Package.swift + Sources/<Module>)
  android/   Gradle 라이브러리 프로젝트, maven/ 에 AAR + POM 배포 (로컬 Maven 저장소)
  docs/      API 문서 (index.html)
`

function parseArgs(argv) {
  const pos = []
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--no-')) opt[a.slice(5)] = false
    else if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) (opt[k] = next), i++
      else opt[k] = true
    } else pos.push(a)
  }
  return { pos, opt }
}

async function validate(specPath, { quiet = false } = {}) {
  const text = readFileSync(specPath, 'utf8')
  const { Parser } = await import('@asyncapi/parser')
  const { document, diagnostics } = await new Parser().parse(text)
  const errors = diagnostics.filter((d) => d.severity === 0)
  for (const d of diagnostics.filter((d) => d.severity <= 1)) {
    console[d.severity === 0 ? 'error' : 'warn'](`${d.severity === 0 ? '✖' : '⚠'} ${d.code}: ${d.message} @ ${d.path.join('.')}`)
  }
  if (!document || errors.length) throw new Error('AsyncAPI 문서가 유효하지 않습니다')
  const model = buildModel(parse(text))
  if (!quiet) console.log(`✓ AsyncAPI ${model.doc.asyncapi} · ${model.title} v${model.version} · operations ${model.operations.length} · types ${model.types.length}`)
  return { text, model }
}

async function build(specPath, opt) {
  const t0 = Date.now()
  const { text, model } = await validate(specPath)
  const out = resolve(opt.out ?? 'bridgegen-out')
  mkdirSync(out, { recursive: true })
  const targets = new Set(String(opt.targets ?? 'js,ios,android,docs').split(','))
  const summary = []
  if (targets.has('js')) {
    console.log(`▸ js  (${model.config.npm.name}@${model.version})`)
    const r = buildJs(model, text, out, { pack: opt.pack !== false })
    summary.push(['npm', r.tgz ? relative(process.cwd(), r.tgz) : relative(process.cwd(), r.dir)])
  }
  if (targets.has('ios')) {
    console.log(`▸ ios (Swift Package ${model.config.swift.module})`)
    const r = buildIos(model, out, { verify: opt['verify-ios'] === true })
    summary.push(['spm', relative(process.cwd(), r.dir)])
  }
  if (targets.has('android')) {
    const a = model.config.android
    console.log(`▸ android (${a.groupId}:${a.artifactId}:${model.version})`)
    const r = buildAndroid(model, out, { publish: opt['android-publish'] !== false })
    summary.push(['maven', r.repo ? `${relative(process.cwd(), r.repo)}  (${a.groupId}:${a.artifactId}:${model.version})` : relative(process.cwd(), r.dir)])
  }
  if (targets.has('docs')) {
    const r = buildDocs(model, text, out)
    summary.push(['docs', relative(process.cwd(), join(r.dir, 'index.html'))])
  }
  console.log(`\n✓ 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  for (const [k, v] of summary) console.log(`  ${k.padEnd(6)} ${v}`)
}

function init(dir = '.') {
  const target = resolve(dir, 'asyncapi.yaml')
  if (existsSync(target)) throw new Error(`${target} 가 이미 있습니다`)
  mkdirSync(resolve(dir), { recursive: true })
  cpSync(join(ROOT, 'examples/ping/asyncapi.yaml'), target)
  console.log(`✓ ${relative(process.cwd(), target)} (ping 예시). 'bridgegen build ${relative(process.cwd(), target)}' 로 만들어 보세요.`)
}

const { pos, opt } = parseArgs(process.argv.slice(2))
const [cmd, ...rest] = pos
try {
  if (cmd === 'build' && rest[0]) await build(rest[0], opt)
  else if (cmd === 'validate' && rest[0]) await validate(rest[0])
  else if (cmd === 'compat' && rest[1]) {
    const r = spawnSync(process.execPath, [join(ROOT, 'src/compat.mjs'), rest[0], rest[1]], { stdio: 'inherit' })
    process.exit(r.status ?? 1)
  } else if (cmd === 'init') init(rest[0])
  else if (opt.version) console.log(VERSION)
  else {
    console.log(HELP)
    process.exit(cmd ? 2 : 0)
  }
} catch (e) {
  console.error(`✖ ${e.message}`)
  process.exit(1)
}
