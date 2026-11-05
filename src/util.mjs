export const HEADER = (c) =>
  `${c} ⚠️ 자동 생성 파일입니다. 직접 수정하지 마세요.\n${c} 원본: AsyncAPI spec · 생성기: bridgegen (https://github.com/<owner>/bridgegen)\n`

export const docLines = (text) =>
  (text ?? '')
    .trim()
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l, i, a) => l || (i > 0 && i < a.length - 1))

/** 'UNKNOWN_METHOD' | 'notDetermined' | 'ios' → 'unknownMethod' | 'notDetermined' | 'ios' */
export function lowerCamel(value) {
  if (/^[A-Z0-9_]+$/.test(value)) {
    return value
      .toLowerCase()
      .split('_')
      .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
      .join('')
  }
  const s = value.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
  return s.charAt(0).toLowerCase() + s.slice(1)
}

/** 'notDetermined' | 'UNKNOWN_METHOD' → 'NOT_DETERMINED' | 'UNKNOWN_METHOD' */
export function screaming(value) {
  return lowerCamel(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
}

export const SWIFT_KEYWORDS = new Set(['default', 'case', 'class', 'struct', 'enum', 'func', 'let', 'var', 'in', 'is', 'as', 'self', 'Self', 'protocol', 'public', 'private', 'internal', 'return', 'true', 'false', 'nil', 'none'])
