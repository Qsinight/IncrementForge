/**
 * 表达式校验与试算的单元测试（TECH_DESIGN 5.8、5.5、7.6、17.1）。
 *
 * 覆盖三类断言：
 * 1. **编译期错误码**：`E_RAND_DISABLED`（价格上下文）、`E_SIDE_EFFECT_FORBIDDEN`（非 effect 上下文的副作用）、
 *    `E_READONLY_TARGET`、`E_UNKNOWN_ATTR`；
 * 2. **按上下文过滤的可用函数**（5.8 的悬浮提示数据源）；
 * 3. **数值/表达式模式判定**（7.6 末条）——含一条回归：`10 * rand()` 必须判为表达式而不是数值。
 */
import { describe, expect, it } from 'vitest'

import { checkExpression, describeContext, snippetsFor, tryEvaluate } from '../src/lib/expression-check.js'
import { isNumericLiteral } from '../src/components/NumExprField.js'
import { batchModeOf, normalizeCountText } from '../src/components/BatchBuyEditor.js'
import { useProjectStore } from '../src/stores/project.js'
import { commitField } from '../src/stores/form.js'
import { addEntry } from '../src/stores/entries.js'

describe('表达式编译期校验（5.6、17.1）', () => {
  it('空白文本视为“无表达式”，合法（默认值即空）', () => {
    expect(checkExpression('', 'field')).toEqual({ ok: true })
    expect(checkExpression('   ', 'price')).toEqual({ ok: true })
  })

  it('价格上下文禁用随机函数（PRD 补充 1 -> E_RAND_DISABLED）', () => {
    const result = checkExpression('10 * rand()', 'price')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('E_RAND_DISABLED')
    // 同一段文本在产出上下文合法：权限是按上下文的（5.5）。
    expect(checkExpression('10 * rand()', 'production').ok).toBe(true)
  })

  it('副作用函数只在 effect 上下文可用（5.5 权限表）', () => {
    expect(checkExpression('set("gen.g1.initial", "2")', 'effect').ok).toBe(true)
    expect(checkExpression('set("gen.g1.initial", "2")', 'production').code).toBe('E_SIDE_EFFECT_FORBIDDEN')
    expect(checkExpression('create("upgrade", { page: "p1" })', 'condition').code).toBe('E_SIDE_EFFECT_FORBIDDEN')
  })

  it('写只读属性报 E_READONLY_TARGET（5.9.1）', () => {
    expect(checkExpression('gen.g1.perSec = 1', 'effect').code).toBe('E_READONLY_TARGET')
    expect(checkExpression('page.p1.columns = 3', 'effect').code).toBe('E_READONLY_TARGET')
  })

  it('未知属性/语法错误分别报 E_UNKNOWN_ATTR / E_PARSE', () => {
    expect(checkExpression('res.r1.bought', 'field').code).toBe('E_UNKNOWN_ATTR')
    expect(checkExpression('1 +', 'field').code).toBe('E_PARSE')
  })

  it('资源没有 bought、但有 owned 别名（PRD 补充 3 / D-37）', () => {
    expect(checkExpression('res.r1.owned', 'field').ok).toBe(true)
  })
})

describe('上下文提示（5.4 是 5.5 的投影、5.8 悬浮提示）', () => {
  it('价格上下文不含随机函数与副作用函数', () => {
    const names = describeContext('price').map((hint) => hint.name)
    expect(names).not.toContain('rand')
    expect(names).not.toContain('set')
    expect(names).toContain('min')
  })

  it('effect 上下文才包含 set/create/destroy', () => {
    const names = describeContext('effect').map((hint) => hint.name)
    expect(names).toEqual(expect.arrayContaining(['set', 'create', 'destroy']))
    expect(names).toContain('rand')
  })

  it('片段包含当前条目自身属性与常用价格写法（5.8）', () => {
    const labels = snippetsFor('gen.g1').map((snippet) => snippet.code)
    expect(labels).toContain('gen.g1.owned')
    expect(labels).toContain('10 * 1.15 ^ gen.g1.bought')
  })
})

describe('数值/表达式模式判定（7.6 末条、D-46）', () => {
  it('纯数字字面量（含分层指数与 Infinity）判为数值模式', () => {
    expect(isNumericLiteral('10')).toBe(true)
    expect(isNumericLiteral('1e10')).toBe(true)
    expect(isNumericLiteral('1e1e10')).toBe(true)
    expect(isNumericLiteral('-2.5e-3')).toBe(true)
    expect(isNumericLiteral('Infinity')).toBe(true)
    expect(isNumericLiteral('')).toBe(true)
  })

  it('回归：宽松数值解析不得把表达式误判为数值（否则 E_RAND_DISABLED 被静默吞掉）', () => {
    // break_eternity 的 fromString 会把 `10 * rand()` 解析成 10 并忽略尾部，因此不能用它做判定。
    expect(isNumericLiteral('10 * rand()')).toBe(false)
    expect(isNumericLiteral('res.r1.amount * 2')).toBe(false)
  })
})

describe('批量购买三态（PRD 生成器 8、8.6、D-36）', () => {
  it('按文本判定 count / max / free', () => {
    expect(batchModeOf('1')).toBe('count')
    expect(batchModeOf('100')).toBe('count')
    expect(batchModeOf('0')).toBe('max')
    expect(batchModeOf('-1')).toBe('free')
    // 表达式文本先按 count 处理，真正的归一化在运行时（5.9.3 的 ①~④）。
    expect(batchModeOf('res.r1.amount')).toBe('count')
  })

  it('纯数值写法按 5.9.3 的 ③④ 归一化（≥1 夹 100；0/负数保持语义）', () => {
    expect(normalizeCountText('3.7')).toBe('3')
    expect(normalizeCountText('1e1e10')).toBe('100')
    expect(normalizeCountText('0')).toBe('0')
    expect(normalizeCountText('-1')).toBe('-1')
  })
})

describe('影子运行时试算（5.8、ADR-03）', () => {
  it('在影子运行时里求值并给出耗时；非法文本给出错误而不是抛异常', () => {
    const id = addEntry('generator')
    commitField('generator', id, 'gen-initial', (draft) => void (draft.initial = '4'))
    expect(useProjectStore.getState().project.generators[0]!.id).toBe(id)

    const preview = tryEvaluate('gen.' + id + '.initial * 2', 'field')
    expect(preview?.text).toBe('8')
    expect(typeof preview?.ms).toBe('number')

    const bad = tryEvaluate('1 +', 'field')
    expect(bad?.error).toBeTruthy()
  })

  it('空白文本不试算（返回 undefined，UI 显示占位而不是 0）', () => {
    expect(tryEvaluate('   ', 'field')).toBeUndefined()
  })
})
