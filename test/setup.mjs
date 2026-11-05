// 테스트 전에 예시 spec으로 소스를 생성한다 (패키징 · Gradle 없이)
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { buildModel } from '../src/model.mjs'
import { buildAndroid, buildIos, buildJs } from '../src/targets.mjs'

export function setup() {
  const spec = new URL('../examples/ping/asyncapi.yaml', import.meta.url)
  const text = readFileSync(spec, 'utf8')
  const model = buildModel(parse(text))
  const out = new URL('./.gen', import.meta.url).pathname
  const log = () => {}
  buildJs(model, text, out, { pack: false, log })
  buildIos(model, out, { log })
  buildAndroid(model, out, { publish: false, log })
}
