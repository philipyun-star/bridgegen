// 이름 규칙 · 산출물 이름 설정(x-bridgegen)
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const modelPath: string = '../src/model.mjs'
const { buildModel, resolveConfig } = await import(modelPath)
const spec = () => parse(readFileSync(new URL('../examples/ping/asyncapi.yaml', import.meta.url), 'utf8'))
const renamed = (from: string, to: string) => {
  const doc = spec()
  doc.operations[to] = doc.operations[from]
  delete doc.operations[from]
  return doc
}

describe('operation 이름', () => {
  it('점(.)이 들어간 이름 · bridge로 시작하는 이름은 쓸 수 없다', () => {
    expect(() => buildModel(renamed('ping', 'ping.ping'))).toThrow(/lowerCamelCase/)
    expect(() => buildModel(renamed('ping', 'bridgeHello'))).toThrow(/런타임 예약/)
  })

  it('x-bridgegen.reservedNames 와 겹치면 실패한다 (이전 세대 브릿지 이름 보호)', () => {
    const doc = spec()
    doc.info['x-bridgegen'].reservedNames = ['showToast', 'ping']
    expect(() => buildModel(doc)).toThrow(/operations\/ping: x-bridgegen.reservedNames/)
  })
})

describe('x-bridgegen', () => {
  it('예시 spec의 설정을 읽는다', () => {
    expect(resolveConfig(spec())).toMatchObject({
      npm: { name: '@example/ping-bridge' },
      android: { groupId: 'com.example', artifactId: 'ping-bridge', package: 'com.example.pingbridge' },
      swift: { module: 'PingBridge', accessLevel: 'public' },
    })
  })

  it('설정이 없으면 title에서 만든다', () => {
    const doc = spec()
    delete doc.info['x-bridgegen']
    doc.info.title = 'Acme Shop Bridge'
    expect(resolveConfig(doc)).toMatchObject({
      npm: { name: 'acme-shop-bridge' },
      android: { groupId: 'com.example', artifactId: 'acme-shop-bridge', package: 'com.example.acmeshopbridge' },
      swift: { module: 'AcmeShopBridge' },
    })
  })

  it('잘못된 패키지 · 모듈 이름은 거부한다', () => {
    const doc = spec()
    doc.info['x-bridgegen'].android.package = 'Com.Bad'
    expect(() => resolveConfig(doc)).toThrow(/android.package/)
    const doc2 = spec()
    doc2.info['x-bridgegen'].swift.module = 'bad-name'
    expect(() => resolveConfig(doc2)).toThrow(/swift.module/)
  })
})
