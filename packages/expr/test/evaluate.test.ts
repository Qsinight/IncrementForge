/**
 * 求值与副作用用例（TECH_DESIGN 5.6 闭包树与副作用、5.7 调度与 last-good、
 * 8.3 第 6 步提交、8.6.1 只读等级视图、8.7 效果与 `effValue`）。
 *
 * 覆盖 14.2 中属于求值阶段的用例：
 * - 大数运算（1e1e10）、1e1e10 量级的价格表达式；
 * - 副作用**不在求值阶段生效**、只在提交阶段按序应用（8.3.1「唯一提交点」）；
 * - 分桶回滚：`action` 半途抛错 -> 该表达式副作用与 `effValue` 写回一并丢弃；
 * - `effValue` 未赋值 -> 不登记写回；
 * - 每 tick 记忆化、循环检测、last-good、求值预算；
 * - 只读等级视图的记忆化隔离。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Diagnostics, Num } from '@iforge/num'
import type { Decimal } from '@iforge/num'

import { Evaluator, levelOverlayKey, levelOverlayReader, resetCompileCache } from '../src/evaluator.js'
import { EffectBucket, EffectSink } from '../src/effects.js'
import type { Value } from '../src/ast.js'
import { EVAL_BUDGET_PER_TICK } from '../src/limits.js'
import { Harness } from './helpers/harness.js'
import { valueToNumber, valueToString } from './helpers/fixture-store.js'

const num = (n: number): Decimal => Num.fromNumber(n)

beforeEach(() => {
  Num.resetDiagnostics()
  resetCompileCache()
})

describe('4.2 / 5.6：闭包树求值', () => {
  it('常量在编译期折叠，重复求值结果一致', () => {
    const harness = new Harness({ context: 'field' })
    expect(valueToNumber(harness.evaluate('1 + 2 * 3'))).toBe(7)
    expect(valueToNumber(harness.evaluate('1 + 2 * 3'))).toBe(7)
  })

  it('四则运算与括号', () => {
    const harness = new Harness()
    expect(valueToNumber(harness.evaluate('(1 + 2) * 3'))).toBe(9)
    expect(valueToNumber(harness.evaluate('7 % 3'))).toBe(1)
    expect(valueToNumber(harness.evaluate('10 / 4'))).toBe(2.5)
  })

  it('幂右结合', () => {
    const harness = new Harness()
    // break_eternity 的 pow 走 log/exp，存在双精度误差，用近似比较。
    expect(valueToNumber(harness.evaluate('2 ^ 3 ^ 2'))).toBeCloseTo(512, 6)
  })

  it('1e1e10 量级可求值（PRD 补充 2）', () => {
    const harness = new Harness()
    expect(valueToString(harness.evaluate('1e1e10'))).toBe('1e10000000000')
    // layer 1 的尾数只有双精度，`1e1e10 + 1e1e10` 不保证精确等于 2e1e10，
    // 因此按量级关系断言而不是按文本相等。
    const doubled = harness.evaluate('1e1e10 + 1e1e10') as Decimal
    expect(doubled.gt(harness.evaluate('1e1e10') as Decimal)).toBe(true)
    expect(doubled.lt(harness.evaluate('3e1e10') as Decimal)).toBe(true)
  })

  it('读取条目属性并参与运算', () => {
    const harness = new Harness({ entries: { 'gen.g1.bought': num(5), 'res.r1.amount': num(100) } })
    expect(valueToNumber(harness.evaluate('gen.g1.bought * 2'))).toBe(10)
    expect(valueToNumber(harness.evaluate('gen.g1.bought + res.r1.amount'))).toBe(105)
  })

  it('内置函数', () => {
    const harness = new Harness()
    expect(valueToNumber(harness.evaluate('min(3, 1, 2)'))).toBe(1)
    expect(valueToNumber(harness.evaluate('max(3, 1, 2)'))).toBe(3)
    expect(valueToNumber(harness.evaluate('clamp(5, 1, 3)'))).toBe(3)
    expect(valueToNumber(harness.evaluate('floor(2.7)'))).toBe(2)
    expect(valueToNumber(harness.evaluate('log10(1000)'))).toBe(3)
    expect(valueToNumber(harness.evaluate('pow(2, 10)'))).toBeCloseTo(1024, 6)
    expect(valueToNumber(harness.evaluate('if(1 < 2, 10, 20)'))).toBe(10)
  })

  it('&& / || 短路：右操作数不求值', () => {
    const harness = new Harness()
    expect(harness.evaluate('false && res.missing.amount')).toBe(false)
    expect(harness.evaluate('true || res.missing.amount')).toBe(true)
  })

  it('比较运算返回布尔', () => {
    const harness = new Harness({ entries: { 'gen.g1.bought': num(5) } })
    expect(harness.evaluate('gen.g1.bought >= 5')).toBe(true)
    expect(harness.evaluate('gen.g1.bought > 5')).toBe(false)
    expect(harness.evaluate('gen.g1.bought == 5')).toBe(true)
    expect(harness.evaluate('gen.g1.bought != 5')).toBe(false)
  })

  it('数值 0 与布尔 false 不相等（不做 JS 隐式转换）', () => {
    const harness = new Harness({ entries: { 'gen.g1.bought': num(0) } })
    expect(harness.evaluate('gen.g1.bought == false')).toBe(false)
    expect(harness.evaluate('gen.g1.bought == 0')).toBe(true)
  })

  it('Infinity 字面量求值为哨兵且与数值比较正确（D-46）', () => {
    const harness = new Harness()
    expect(harness.evaluate('1e1e10 < Infinity')).toBe(true)
    expect(harness.evaluate('Infinity < 1e1e10')).toBe(false)
    expect(valueToString(harness.evaluate('Infinity'))).toBe('Infinity')
  })
})

describe('5.6：副作用不在求值阶段生效（8.3.1 唯一提交点）', () => {
  it('set() 只登记，不立即改写存储', () => {
    const harness = new Harness({ context: 'effect' })
    harness.sink.startBucket('test')
    harness.evaluate('set("gen.g1.bought", 5)')
    expect(harness.applied).toHaveLength(0)
    harness.commit()
    expect(harness.applied).toHaveLength(1)
    expect(harness.applied[0]).toMatchObject({ kind: 'set', path: 'gen.g1.bought' })
  })

  it('提交阶段按书写顺序应用（5.6）', () => {
    const harness = new Harness({ context: 'effect' })
    harness.sink.startBucket('test')
    harness.evaluate('set("gen.g1.bought", 1)')
    harness.evaluate('set("gen.g1.owned", 2)')
    harness.commit()
    expect(harness.applied.map((e) => e.path)).toEqual(['gen.g1.bought', 'gen.g1.owned'])
  })

  it('destroy 先于 create（8.3 第 6 步）', () => {
    const harness = new Harness({ context: 'effect' })
    harness.sink.startBucket('test')
    harness.evaluate('create("upgrade", { page: "p1" })')
    harness.evaluate('destroy("u1")')
    harness.commit()
    expect(harness.applied.map((e) => e.kind)).toEqual(['destroy', 'create'])
  })

  it('赋值表达式同样走副作用登记而非直接写入', () => {
    const harness = new Harness({ context: 'effect' })
    harness.sink.startBucket('test')
    harness.evaluate('gen.g1.bought = 7')
    expect(harness.applied).toHaveLength(0)
    harness.commit()
    expect(harness.applied[0]).toMatchObject({ kind: 'set', path: 'gen.g1.bought' })
  })

  it('复合赋值读取真值再登记（8.5 bought 独立可写）', () => {
    const harness = new Harness({ context: 'effect', entries: { 'gen.g1.bought': num(4) } })
    harness.sink.startBucket('test')
    harness.evaluate('gen.g1.bought += 3')
    harness.commit()
    expect(valueToNumber(harness.applied[0]!.value as Decimal)).toBe(7)
  })

  it('create() 的 spec 在编译期折叠为常量原样透传（8.7 字段形态）', () => {
    const harness = new Harness({ context: 'effect' })
    harness.sink.startBucket('test')
    harness.evaluate('create("upgrade", { id: "uTmp", name: "x", page: "p1", costs: [{ materialId: "r1", amount: "10" }] })')
    harness.commit()
    const effect = harness.applied[0]!
    expect(effect.kind).toBe('create')
    expect(effect.createKind).toBe('upgrade')
    expect(effect.spec).toMatchObject({ id: 'uTmp', page: 'p1', costs: [{ materialId: 'r1', amount: '10' }] })
  })
})

describe('5.6：分桶与回滚', () => {
  it('求值抛错时 EffectSink 不留下任何副作用（5.6「要么整体生效、要么完全不生效」）', () => {
    const harness = new Harness({
      context: 'effect',
      // `res.r1.amount` 静态检查通过（属性存在），但运行期读取失败：
      // 这正是 5.6 描述的“表达式求值过程中抛错”场景——前半段的 `set()` 已经登记。
      // 宿主（AttributeStore）抛的错误按约定只需带 `code` 字段，不要求是本包的 ForgeError。
      readOverride: (key) => {
        if (key === 'res.r1.amount') {
          throw Object.assign(new Error('属性在运行期不可用'), { code: 'E_UNKNOWN_ATTR' })
        }
        return undefined
      },
      entries: { 'gen.g1.bought': num(0) },
    })
    // 副作用必须在其所属效果的分桶内登记（8.7），先开一个分桶。
    harness.sink.startBucket('up.u1#effects[0]')
    const result = harness.evaluator.evaluate('set("gen.g1.bought", 1) + res.r1.amount')
    expect(result.lastGood).toBe(true)
    expect(result.code).toBe('E_UNKNOWN_ATTR')
    expect(harness.sink.buckets()).toHaveLength(0)
    expect(harness.commit()).toBe(0)
  })

  it('在分桶之外调用副作用函数被运行期兜底拒绝（E_SIDE_EFFECT_FORBIDDEN）', () => {
    const harness = new Harness({ context: 'effect' })
    // 未开分桶：静态检查已放行（上下文正确），但登记时无桶可入。
    const result = harness.evaluator.evaluate('set("gen.g1.bought", 1)')
    expect(result.lastGood).toBe(true)
    expect(result.code).toBe('E_SIDE_EFFECT_FORBIDDEN')
  })

  it('分桶被丢弃后其副作用不进入提交队列', () => {
    const sink = new EffectSink()
    const bucket = sink.startBucket('a')
    sink.emit('set', { path: 'gen.g1.bought', value: num(1) }, 'x')
    expect(bucket.effects).toHaveLength(1)
    sink.discard(bucket)
    expect(bucket.effects).toHaveLength(0)
    let applied = 0
    sink.commit(() => {
      applied += 1
    })
    expect(applied).toBe(0)
  })

  it('丢弃一个分桶不影响其它分桶（5.6「其它表达式已收集的副作用不受影响」）', () => {
    const sink = new EffectSink()
    const good = sink.startBucket('good')
    sink.emit('set', { path: 'gen.g1.bought', value: num(1) }, 'a')
    const bad = sink.startBucket('bad')
    sink.emit('set', { path: 'gen.g1.owned', value: num(2) }, 'b')
    sink.discard(bad)
    sink.endBucket()
    const applied: string[] = []
    sink.commit((effect) => {
      applied.push(effect.path ?? '')
    })
    expect(applied).toEqual(['gen.g1.bought'])
    void good
  })

  it('同一 tick 内多条效果各自一个分桶（8.7）', () => {
    const sink = new EffectSink()
    sink.startBucket('up.u1#effects[0]')
    sink.emit('set', { path: 'gen.g1.bought', value: num(1) }, 'e0')
    sink.endBucket()
    sink.startBucket('up.u1#effects[1]')
    sink.emit('set', { path: 'gen.g1.owned', value: num(2) }, 'e1')
    sink.endBucket()
    expect(sink.buckets()).toHaveLength(2)
  })
})

describe('8.7：effValue 写回与所在分桶同生共死', () => {
  it('action 未赋值 effValue 时不登记写回（不递增 version）', () => {
    const bucket = new EffectBucket('up.u1#effects[0]')
    bucket.commitEffValue(false, 'up.u1.effectValues[0]', num(5))
    expect(bucket.takeEffValueWriteback()).toBeUndefined()
  })

  it('action 赋值 effValue 时登记写回', () => {
    const bucket = new EffectBucket('up.u1#effects[0]')
    bucket.commitEffValue(true, 'up.u1.effectValues[0]', num(5))
    expect(bucket.takeEffValueWriteback()).toEqual({ path: 'up.u1.effectValues[0]', value: expect.anything() })
  })

  it('写回在提交阶段落地，且与副作用同批', () => {
    const sink = new EffectSink()
    const bucket = sink.startBucket('up.u1#effects[1]')
    sink.emit('set', { path: 'gen.g1.bought', value: num(1) }, 'a')
    bucket.commitEffValue(true, 'up.u1.effectValues[1]', num(3))
    sink.endBucket()
    const applied: string[] = []
    sink.commit((effect) => {
      applied.push(`${effect.kind}:${effect.path}`)
    })
    expect(applied).toEqual(['set:up.u1.effectValues[1]', 'set:gen.g1.bought'])
  })

  it('分桶丢弃时写回一并丢弃（action 抛错 -> effectValues[i] 保持上次成功值）', () => {
    const sink = new EffectSink()
    const bucket = sink.startBucket('up.u1#effects[1]')
    bucket.commitEffValue(true, 'up.u1.effectValues[1]', num(3))
    sink.discard(bucket)
    let applied = 0
    sink.commit(() => {
      applied += 1
    })
    expect(applied).toBe(0)
  })

  it('effValue 在 effect 上下文中可读可写（局部变量，写回登记进分桶）', () => {
    const harness = new Harness({ context: 'effect' })
    harness.evaluateEffect('up.u1#effects[1]', 'effValue = 3', { effValue: num(0), effValueAssigned: true })
    // 写回与其它副作用一样只在提交阶段落地（5.6）。
    expect(harness.applied).toHaveLength(0)
    harness.commit()
    expect(harness.applied[0]).toMatchObject({ kind: 'set', path: 'up.u1.effectValues[0]' })
  })
})

describe('5.7：每 tick 记忆化', () => {
  it('同一 tick 内同表达式只求值一次', () => {
    const harness = new Harness({ entries: { 'gen.g1.bought': num(3) } })
    harness.beginTick(1)
    harness.evaluate('gen.g1.bought * 2')
    harness.evaluate('gen.g1.bought * 2')
    const reads = harness.store.reads.filter((k) => k === 'gen.g1.bought').length
    expect(reads).toBe(1)
  })

  it('beginTick 后缓存清空，重新求值', () => {
    const harness = new Harness({ entries: { 'gen.g1.bought': num(3) } })
    harness.beginTick(1)
    harness.evaluate('gen.g1.bought')
    harness.beginTick(2)
    harness.evaluate('gen.g1.bought')
    expect(harness.store.reads.filter((k) => k === 'gen.g1.bought').length).toBe(2)
  })

  it('相同文本在不同 tick 求值出不同结果', () => {
    let value = num(1)
    const harness = new Harness({ readOverride: (key) => (key === 'gen.g1.bought' ? value : undefined) })
    harness.beginTick(1)
    expect(valueToNumber(harness.evaluate('gen.g1.bought'))).toBe(1)
    value = num(9)
    harness.beginTick(2)
    expect(valueToNumber(harness.evaluate('gen.g1.bought'))).toBe(9)
  })
})

describe('8.6.1：只读等级视图的记忆化隔离', () => {
  const PRICE = '10 * 1.15 ^ gen.g1.bought'

  it('同一 tick 内连续求不同 j 的结果互不相同', () => {
    const bought = num(0)
    const harness = new Harness({
      context: 'price',
      readOverride: (key) => (key === 'gen.g1.bought' ? bought : undefined),
    })
    harness.beginTick(1)
    const prices: number[] = []
    for (const j of [0, 1, 2, 3, 4]) {
      const level = num(j)
      prices.push(
        valueToNumber(
          harness.evaluate(PRICE, { read: levelOverlayReader(harness.store.read, 'gen.g1.bought', level) }, levelOverlayKey('gen.g1.bought', level)),
        ),
      )
    }
    expect(new Set(prices).size).toBe(5)
    // 14.2：j = 5 时应等于 10 * 1.15^5。
    const level5 = num(5)
    const p5 = harness.evaluate(
      PRICE,
      { read: levelOverlayReader(harness.store.read, 'gen.g1.bought', level5) },
      levelOverlayKey('gen.g1.bought', level5),
    )
    expect(valueToNumber(p5)).toBeCloseTo(10 * 1.15 ** 5, 6)
  })

  it('覆盖层不修改 AttributeStore：bought 保持 0', () => {
    const harness = new Harness({ context: 'price', entries: { 'gen.g1.bought': num(0) } })
    harness.beginTick(1)
    const level = num(7)
    harness.evaluate(PRICE, { read: levelOverlayReader(harness.store.read, 'gen.g1.bought', level) }, levelOverlayKey('gen.g1.bought', level))
    // 存储未被改写：读到的仍是 0，且没有产生任何副作用（8.6.1「无副作用」）。
    expect(harness.applied).toHaveLength(0)
    expect(valueToNumber(harness.store.read('gen.g1.bought'))).toBe(0)
  })

  it('无覆盖层时不附加缓存段', () => {
    const harness = new Harness({ entries: { 'gen.g1.bought': num(2) } })
    harness.beginTick(1)
    expect(valueToNumber(harness.evaluate(PRICE))).toBeCloseTo(10 * 1.15 ** 2, 6)
  })
})

describe('5.7：last-good 与错误处理（D-07）', () => {
  it('求值失败时保留上次成功值并记诊断，不抛异常', () => {
    const harness = new Harness({ entries: { 'gen.g1.bought': num(5) } })
    harness.beginTick(1)
    expect(valueToNumber(harness.evaluate('gen.g1.bought'))).toBe(5)

    harness.beginTick(2)
    // 第二 tick 让属性读取失败（模拟目标被删除）。
    harness.store.set('gen.g1.bought', num(5))
    const original = harness.store.read
    ;(harness.store as unknown as { read: (key: string) => unknown }).read = () => {
      throw Object.assign(new Error('E_UNKNOWN_ATTR'), { code: 'E_UNKNOWN_ATTR' })
    }
    const result = harness.evaluator.evaluate('gen.g1.bought')
    expect(result.lastGood).toBe(true)
    expect(result.code).toBe('E_UNKNOWN_ATTR')
    expect(valueToNumber(result.value)).toBe(5)
    ;(harness.store as unknown as { read: unknown }).read = original
  })

  it('无 last-good 时返回按类型的中性值', () => {
    const harness = new Harness({})
    harness.beginTick(1)
    const result = harness.evaluator.evaluate('res.missing.amount')
    expect(result.lastGood).toBe(true)
    expect(valueToNumber(result.value)).toBe(0)
  })

  it('布尔表达式失败时回退 false，字符串回退空串', () => {
    const harness = new Harness({})
    harness.beginTick(1)
    expect(harness.evaluator.evaluate('res.missing.visible > 1').value).toBe(false)
    expect(harness.evaluator.evaluate('res.missing.description').value).toBe('')
  })

  it('诊断被记录到 Diagnostics（D-07 不中断 tick）', () => {
    const harness = new Harness({})
    harness.beginTick(1)
    harness.evaluator.evaluate('res.missing.amount')
    expect(Diagnostics.total()).toBeGreaterThan(0)
  })
})

describe('5.7：依赖环检测', () => {
  it('依赖环检测', () => {
    // `gen.g1.perSec` 的派生计算回头再读 `gen.g1.perSec`，构成 5.7 的求值重入。
    // 内层求值被循环检测拦下 -> 取 last-good；外层随之继续（tick 不中断，R-07）。
    let nested: ReturnType<Evaluator['evaluate']> | undefined
    let reentered = false
    const evaluator: Evaluator = new Evaluator('field', {
      read: (key: string): Value => {
        if (key === 'gen.g1.perSec' && !reentered) {
          reentered = true
          // 派生计算回头再读同一属性 -> 重入。
          nested = evaluator.evaluate('gen.g1.perSec')
          return nested.value
        }
        return num(1)
      },
      emit: () => num(0),
    })
    const outer = evaluator.evaluate('gen.g1.perSec')

    // 外层：读到的是内层的回退值，tick 不中断（D-07）。
    expect(outer.lastGood).toBe(false)
    expect(valueToNumber(outer.value)).toBe(0)
    // 内层：循环检测命中，报 E_CYCLE 并按 last-good 处理。
    expect(nested?.lastGood).toBe(true)
    expect(nested?.code).toBe('E_CYCLE')
    expect(Diagnostics.count('E_CYCLE')).toBeGreaterThan(0)
  })
})

describe('5.7：求值预算', () => {
  it('单 tick 求值次数上限为 EVAL_BUDGET_PER_TICK', () => {
    const harness = new Harness({})
    harness.beginTick(1)
    for (let i = 0; i < EVAL_BUDGET_PER_TICK + 10; i += 1) {
      harness.evaluate(`1 + ${i}`)
    }
    expect(harness.evaluator.isBudgetExhausted()).toBe(true)
    expect(Diagnostics.count('E_BUDGET')).toBeGreaterThan(0)
  })

  it('beginTick 重置预算', () => {
    const harness = new Harness({})
    harness.beginTick(1)
    harness.evaluate('1 + 1')
    expect(harness.evaluator.isBudgetExhausted()).toBe(false)
    harness.beginTick(2)
    expect(harness.evaluator.evaluations()).toBe(0)
  })

  it('编译结果按 (context, text) 缓存（5.6）', () => {
    const evaluator = new Evaluator('field', { read: () => num(0), emit: () => num(0) })
    const first = evaluator.compile('1 + 2')
    const second = evaluator.compile('1 + 2')
    expect(first).toBe(second)
    // 上下文必须进缓存键：同一文本在 price 下会因权限不同而编译出不同结果。
    const priceEvaluator = new Evaluator('price', { read: () => num(0), emit: () => num(0) })
    expect(priceEvaluator.compile('1 + 2')).not.toBe(first)
  })
})

describe('8.3 第 1 步：确定性随机源', () => {
  it('同一 tick 的 rand 结果可复现', () => {
    const harness = new Harness()
    harness.beginTick(7)
    const first = valueToString(harness.evaluate('rand()'))
    harness.beginTick(7)
    const second = valueToString(harness.evaluate('rand()'))
    expect(first).toBe(second)
  })

  it('不同 tick 的 rand 结果不同', () => {
    const harness = new Harness()
    harness.beginTick(1)
    const first = valueToString(harness.evaluate('rand()'))
    harness.beginTick(2)
    const second = valueToString(harness.evaluate('rand()'))
    expect(first).not.toBe(second)
  })

  it('rand() 返回 [0, 1)', () => {
    const harness = new Harness()
    for (let tick = 0; tick < 20; tick += 1) {
      harness.beginTick(tick)
      const value = valueToNumber(harness.evaluate('rand()'))
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('randInt 落在闭区间 [min, max]', () => {
    const harness = new Harness()
    for (let tick = 0; tick < 50; tick += 1) {
      harness.beginTick(tick)
      const value = valueToNumber(harness.evaluate('randInt(3, 7)'))
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThanOrEqual(7)
    }
  })
})

describe('8.4：has / count 查询动态条目', () => {
  it('has 返回布尔，count 返回数量', () => {
    const harness = new Harness({
      dynamic: {
        has: (kind, id) => kind === 'upgrade' && id === 'uTmp',
        count: (kind) => num(kind === 'upgrade' ? 3 : 0),
      },
    })
    expect(harness.evaluate('has("upgrade", "uTmp")')).toBe(true)
    expect(harness.evaluate('has("upgrade", "u9")')).toBe(false)
    expect(valueToNumber(harness.evaluate('count("upgrade")'))).toBe(3)
  })

  it('17.2 片段 ② 的幂等守卫写法可求值', () => {
    const harness = new Harness({
      context: 'condition',
      dynamic: { has: () => false, count: () => num(0) },
      entries: { 'gen.g1.bought': num(10) },
    })
    expect(harness.evaluate('gen.g1.bought >= 10 && !has("upgrade", "uTmp")')).toBe(true)
  })
})
