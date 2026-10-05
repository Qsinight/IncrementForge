/**
 * 属性读写矩阵与校验 API 用例（TECH_DESIGN 5.9、5.8、17.2 示例项目、14.3 一致性）。
 *
 * 这些用例同时是**文档一致性**的回归点：
 * - 5.9.1/5.9.2 的每一行可写性都在此断言（14.3 规则 2）；
 * - `PROPERTY_SPECS` 与 17.2 示例项目里出现的属性路径必须全部可编译（14.3 规则 1）。
 */
import { describe, expect, it } from 'vitest'

import { compile } from '../src/compiler.js'
import { parse } from '../src/parser.js'
import {
  LIST_PROPERTIES,
  PROPERTY_SPECS,
  formatPathKey,
  isReadable,
  isWritable,
  normalizePropertyKey,
  parseLiteralPath,
  templateKey,
} from '../src/properties.js'
import { CREATE_SPEC_FIELD_LIST, CREATE_KINDS } from '../src/create-spec.js'
import { validateExpression } from '../src/index.js'

describe('5.9 属性表结构', () => {
  it('表内每项都声明了可读性与存档位置', () => {
    for (const [key, spec] of Object.entries(PROPERTY_SPECS)) {
      expect(typeof key).toBe('string')
      expect(spec.readable, `${key} 必须可读`).toBe(true)
      expect(['top-level', 'assignments', 'derived'], `${key} 的 storage 非法`).toContain(spec.storage)
      expect(spec.prefixes.length, `${key} 必须限定适用的条目前缀`).toBeGreaterThan(0)
    }
  })

  it('只读属性恰好是 5.9.1/5.9.2 标记为不可写的那批', () => {
    const readOnly = Object.entries(PROPERTY_SPECS)
      .filter(([, spec]) => !spec.writable)
      .map(([key]) => templateKey(key))
      .sort()
    // id/order/name/icon（标识与展示）、perSec（派生）、buyDelay（实现细节）、
    // 页面 theme/columns/entries（布局属性）。
    expect(readOnly).toEqual(['buyDelay', 'columns', 'entries', 'icon', 'id', 'name', 'order', 'perSec', 'theme'].sort())
  })

  it('资源无 disabled / bought / isClicker（PRD 未定义，D-20）', () => {
    for (const prefix of ['res'] as const) {
      expect(isReadable(prefix, ['disabled'])).toBe(false)
      expect(isReadable(prefix, ['bought'])).toBe(false)
      expect(isReadable(prefix, ['isClicker'])).toBe(false)
      expect(isReadable(prefix, ['perSecond'])).toBe(false)
      expect(isReadable(prefix, ['buyAmount'])).toBe(false)
    }
  })

  it('generators 与 upgrades 无 produces（5.9.1）', () => {
    expect(isReadable('up', ['produces', '0', 'amount'])).toBe(false)
    expect(isReadable('gen', ['produces', '0', 'amount'])).toBe(true)
    expect(isReadable('gen', ['conditions', '0'])).toBe(false)
    expect(isReadable('gen', ['effects', '0', 'condition'])).toBe(false)
    expect(isReadable('up', ['conditions', '0'])).toBe(true)
    expect(isReadable('up', ['effectValues', '0'])).toBe(true)
  })

  it('res.owned 是 amount 的别名（D-37、5.9.1 第 8 行）', () => {
    expect(isReadable('res', ['owned'])).toBe(true)
    expect(isWritable('res', ['owned'])).toBe(true)
    expect(isWritable('gen', ['owned'])).toBe(true)
  })

  it('normalizePropertyKey 生成模板键，templateKey 归一具体下标', () => {
    expect(normalizePropertyKey(['costs', '0', 'amount'])).toBe('costs[0].amount')
    expect(normalizePropertyKey(['effects', '2', 'action'])).toBe('effects[2].action')
    expect(templateKey('effectValues[3]')).toBe('effectValues[i]')
    expect(formatPathKey('gen', 'g1', ['costs', '0', 'amount'])).toBe('gen.g1.costs[0].amount')
    expect(formatPathKey('res', 'r1', ['amount'])).toBe('res.r1.amount')
  })

  it('列表属性集合与 5.9.1 一致', () => {
    // 用集合比较：`sort()` 对大小写敏感（'effectValues' 会排在 'effects' 之前），
    // 直接比较排序结果会被字母序细节干扰。
    expect(new Set(LIST_PROPERTIES)).toEqual(new Set(['costs', 'produces', 'conditions', 'effects', 'effectValues']))
  })
})

describe('5.4 / 5.9.3：字面量路径解析', () => {
  it('解析成功并定位到**具体**键（模板键只用于查表，见 ResolvedProperty 的契约）', () => {
    const path = parseLiteralPath('gen.g1.produces[0].amount')
    // `key` 必须是具体键：`set("gen.g1.produces[0].amount", …)` 在运行期要能定位到第 0 行，
    // 若这里返回模板键 `produces[i].amount`，运行时就会丢掉下标（写不到任何一行）。
    expect(path).toMatchObject({ prefix: 'gen', id: 'g1', key: 'produces[0].amount', attrs: ['produces', '0', 'amount'] })
    expect(path?.spec?.writable).toBe(true)
    // 查表用的仍是模板形式。
    expect(templateKey(path!.key)).toBe('produces[i].amount')
    // 下标不同 -> 具体键不同，但命中的规格相同。
    const third = parseLiteralPath('gen.g1.produces[3].amount')
    expect(third?.key).toBe('produces[3].amount')
    expect(third?.spec).toBe(path?.spec)
  })

  it('res.<id>.owned 是 amount 的别名：键保持 owned、规格取 amount（D-37）', () => {
    const path = parseLiteralPath('res.r1.owned')
    expect(path?.key).toBe('owned')
    expect(path?.spec).toBe(PROPERTY_SPECS['amount'])
  })

  it('不可解析的路径返回 undefined', () => {
    expect(parseLiteralPath('gen.g1')).toBeUndefined()
    expect(parseLiteralPath('nope.g1.amount')).toBeUndefined()
    expect(parseLiteralPath('')).toBeUndefined()
  })

  it('能解析但属性不存在的路径返回 spec 为 undefined（调用方报 E_UNKNOWN_ATTR）', () => {
    // `costs[0]` 是整行对象，不是可读写的属性字段（可访问的是 .materialId / .amount）。
    const wholeRow = parseLiteralPath('gen.g1.costs[0]')
    expect(wholeRow).toBeDefined()
    expect(wholeRow?.spec).toBeUndefined()
  })
})

describe('8.7：create() spec 字段白名单', () => {
  it('两类条目的字段集合符合 8.7', () => {
    expect(CREATE_KINDS).toEqual(['generator', 'upgrade'])
    expect(CREATE_SPEC_FIELD_LIST.generator).toContain('produces')
    expect(CREATE_SPEC_FIELD_LIST.generator).not.toContain('conditions')
    expect(CREATE_SPEC_FIELD_LIST.upgrade).toContain('effects')
    expect(CREATE_SPEC_FIELD_LIST.upgrade).not.toContain('produces')
    // 公共字段（含 PRD 补充 7 要求的 page）
    for (const field of ['id', 'name', 'description', 'icon', 'initial', 'max', 'visible', 'order', 'page']) {
      expect(CREATE_SPEC_FIELD_LIST.generator).toContain(field)
      expect(CREATE_SPEC_FIELD_LIST.upgrade).toContain(field)
    }
    // `kind`/`buyDelay` 由运行时接管，不在白名单内
    expect(CREATE_SPEC_FIELD_LIST.generator).not.toContain('kind')
    expect(CREATE_SPEC_FIELD_LIST.generator).not.toContain('buyDelay')
  })
})

describe('17.2：示例项目的表达式全部可编译', () => {
  const CASES: Array<{ context: Parameters<typeof compile>[2]; text: string }> = [
    { context: 'price', text: '10 * 1.15 ^ gen.g1.bought' },
    { context: 'production', text: '1' },
    { context: 'condition', text: 'gen.g1.bought >= 5' },
    { context: 'condition', text: 'gen.g1.bought >= 10 && !has("upgrade", "uTmp")' },
    { context: 'effect', text: 'set("gen.g1.produces[0].amount", "2")' },
    { context: 'effect', text: 'effValue = 1.5 * gen.g1.owned' },
    { context: 'field', text: 'Infinity' },
    { context: 'field', text: '1e1e10' },
    { context: 'condition', text: 'true' },
  ]

  for (const { context, text } of CASES) {
    it(`可编译：${context} / ${text}`, () => {
      expect(() => compile(parse(text), text, context)).not.toThrow()
    })
  }

  it('17.2 片段 ② 的完整动态创建表达式可编译', () => {
    const text =
      'create("upgrade", { id: "uTmp", name: "临时强化", description: "动态条目，不进项目文件", page: "p1", initial: "0", max: "1", costs: [{ materialId: "r1", amount: "50" }], conditions: ["true"] })'
    expect(() => compile(parse(text), text, 'effect')).not.toThrow()
  })

  it('依赖收集覆盖示例项目用到的属性', () => {
    const compiled = compile(parse('10 * 1.15 ^ gen.g1.bought'), '10 * 1.15 ^ gen.g1.bought', 'price')
    expect(compiled.deps).toEqual(['gen.g1.bought'])
  })
})

describe('5.8：编辑器实时校验入口', () => {
  it('合法表达式返回 ok', () => {
    expect(validateExpression('1 + 2', 'field')).toEqual({ ok: true })
  })

  it('非法表达式返回错误码与位置', () => {
    const result = validateExpression('1 +', 'field')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('E_PARSE')
      expect(result.span).toBeDefined()
    }
  })

  it('上下文权限错误也能被校验入口捕获（编辑器红框，5.8）', () => {
    const result = validateExpression('rand()', 'price')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('E_RAND_DISABLED')
  })

  it('只读属性错误可定位到列区间（5.8 红色下划线）', () => {
    const result = validateExpression('gen.g1.perSec = 1', 'effect')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('E_READONLY_TARGET')
      expect(result.span?.start).toBeGreaterThanOrEqual(0)
    }
  })
})
