/**
 * `AttributeStore` 的三张赋值表与别名/只读约束（TECH_DESIGN 5.9、5.9.1、5.9.2、5.9.3、13）。
 *
 * 5.9.3 明确要求三张赋值表逐行断言（14.3 规则 2）：
 * - ① **数值常量** `initial/max/buyAmount` 与 `costs[i].amount`；
 * - ② **数值表达式** `initial/max/amount/bought/owned/effectValues[i]`；
 * - ③ **布尔 / 字符串 / 表达式文本**。
 *
 * 以及 `res.<id>.owned` 别名（D-37）、只读目标 `E_READONLY_TARGET`（13 第 1 组）。
 *
 * **一个必须分清的点**：`initial/max/buyAmount/costs[i].amount` 是**文本字段**——
 * 存的是表达式源码（D-29：运行时读写与编辑期求值同源），所以 `write()` 送进来的
 * 字符串只要在对应上下文能编译就接受。5.9.3 表格里“非数字文本报 `E_ASSIGN_TYPE`”
 * 指的是**赋值表达式的右值类型**（`gen.g1.initial = true`），那是编译期检查，
 * 由 `validateExpression` 断言，不是在 `write()` 这一层。
 */
import { describe, expect, it } from 'vitest'

import { Num } from '@iforge/num'
import { validateExpression } from '@iforge/expr'

import { upgradeDefPerSecond } from '../src/game-state.js'
import { evaluateCostAt } from '../src/purchase.js'
import { Num as N } from '@iforge/num'
import { Harness, assignToPage, createDefaultProject, createExampleProject, withGenerator, withUpgrade } from './helpers/harness.js'

/** 一个资源 + 一个生成器 + 一个升级 + 一个页面的完整最小项目。 */
function full(): Harness {
  const project = createDefaultProject()
  project.resources = [
    {
      kind: 'resource',
      id: 'r1',
      order: 1,
      name: '矿石',
      description: '',
      icon: { kind: 'builtin', value: 'gem' },
      initial: '0',
      max: 'Infinity',
      visible: true,
    },
  ]
  const withGen = assignToPage(
    withGenerator({ id: 'g1', costs: [{ materialId: 'r1', amount: '10' }], produces: [{ materialId: 'r1', amount: '1' }] }, project),
    'p1',
    ['r1', 'g1'],
  )
  const withUp = withUpgrade({ id: 'u1', costs: [], conditions: [], effects: [{ condition: 'true', action: 'effValue = 1' }] }, withGen)
  return new Harness({ project: assignToPage(withUp, 'p1', ['r1', 'g1', 'u1']) })
}

describe('5.9.3 ① / ② 文本型字段（`NumExpr`）', () => {
  it('`initial` / `max` / `buyAmount` 存的是表达式文本，读时求值', () => {
    const h = full()
    const generator = h.generator('g1')
    expect(h.state.attrs.write('gen.g1.initial', '12.5', '<test>')).toBe(true)
    expect(h.state.attrs.textOr(generator, 'initial')).toBe('12.5')
    expect(h.state.attrs.write('gen.g1.max', '1000', '<test>')).toBe(true)
    expect(h.state.attrs.capOf(generator).toNumber()).toBe(1000)
    // 表达式同样可以（D-29 同源）：`max` 是运行时求值的。
    h.state.attrs.write('gen.g1.max', '2 ^ 10', '<test>')
    expect(h.state.attrs.capOf(generator).toNumber()).toBeCloseTo(1024, 9)
    expect(h.state.attrs.write('gen.g1.buyAmount', '7', '<test>')).toBe(true)
    expect(h.state.attrs.fieldValue(generator, 'buyAmount').toNumber()).toBe(7)
  })

  it('`costs[i].amount` 原样替换为表达式文本', () => {
    const h = full()
    expect(h.state.attrs.write('gen.g1.costs[0].amount', '25', '<test>')).toBe(true)
    expect(h.state.attrs.textOr(h.generator('g1'), 'costs[0].amount')).toBe('25')
    expect(h.state.attrs.write('gen.g1.costs[0].amount', '10 * 1.15 ^ gen.g1.bought', '<test>')).toBe(true)
    expect(h.state.attrs.textOr(h.generator('g1'), 'costs[0].amount')).toBe('10 * 1.15 ^ gen.g1.bought')
  })

  it('编译不合法的文本被拒且保留旧文本（last-good，5.9.3）', () => {
    const h = full()
    const generator = h.generator('g1')
    // `price` 上下文禁止随机数（5.5）。
    expect(h.state.attrs.write('gen.g1.costs[0].amount', 'rand()', '<test>')).toBe(false)
    expect(h.state.attrs.textOr(generator, 'costs[0].amount')).toBe('10')
    expect(h.state.diagnosticCount('E_RAND_DISABLED')).toBe(1)
    // 语法错误同理。
    expect(h.state.attrs.write('gen.g1.costs[0].amount', '1 +', '<test>')).toBe(false)
    expect(h.state.attrs.textOr(generator, 'costs[0].amount')).toBe('10')
  })

  it('`max` 写非正数在**读取**时被兜底为 1（4.4 第 4 条），写入本身不报错', () => {
    const h = full()
    const generator = h.generator('g1')
    expect(h.state.attrs.write('gen.g1.max', '-3', '<test>')).toBe(true)
    expect(h.state.attrs.textOr(generator, 'max')).toBe('-3')
    expect(h.state.attrs.capOf(generator).toNumber()).toBe(1)
    expect(h.state.diagnosticCount('E_CAP_NON_POSITIVE')).toBeGreaterThan(0)
  })

  it('`buyAmount` 归一化：`3.7 -> 3`、`250 -> 100`、`0 -> 0`、`-1 -> -1`（5.9.3 表格）', () => {
    const cases: [string, number][] = [
      ['3.7', 3],
      ['250', 100],
      ['0', 0],
      ['-1', -1],
    ]
    for (const [text, expected] of cases) {
      const h = full()
      const generator = h.generator('g1')
      expect(h.state.attrs.write('gen.g1.buyAmount', text, '<test>'), text).toBe(true)
      expect(h.state.attrs.fieldValue(generator, 'buyAmount').toNumber(), text).toBe(expected)
    }
  })

  it('“非数字文本报 `E_ASSIGN_TYPE`” 是**编译期**的右值类型检查（5.9.3 表格）', () => {
    // `initial` 是数值字段：`gen.g1.initial = true` 编译期就被拒。
    expect(validateExpression('gen.g1.initial = true', 'effect').ok).toBe(false)
    expect(validateExpression('gen.g1.initial = 2 * gen.g1.owned', 'effect').ok).toBe(true)
    // `visible` 是布尔字段：`= 3` 被拒。
    expect(validateExpression('gen.g1.visible = 3', 'effect').ok).toBe(false)
    expect(validateExpression('gen.g1.visible = true', 'effect').ok).toBe(true)
    // 文本字段赋字符串被拒（`description` 除外，见 ③）。
    expect(validateExpression('gen.g1.description = "x"', 'effect').ok).toBe(true)
  })
})

describe('5.9.3 ② 直接存储的数值字段', () => {
  it('`amount` / `bought` / `owned` 接受 `Decimal`，不接受字符串或布尔', () => {
    const h = full()
    const resource = h.state.attrs.require('res.r1')
    expect(h.state.attrs.write('res.r1.amount', Num.fromNumber(42), '<test>')).toBe(true)
    expect(h.state.attrs.value(resource, 'amount').toNumber()).toBe(42)
    expect(h.state.attrs.write('gen.g1.bought', Num.fromNumber(7), '<test>')).toBe(true)
    expect(h.state.attrs.value(h.generator('g1'), 'bought').toNumber()).toBe(7)
    // 字符串被拒：`amount` 存的是数值，不是文本。
    expect(h.state.attrs.write('res.r1.amount', '42', '<test>')).toBe(false)
    expect(h.state.attrs.write('res.r1.amount', true, '<test>')).toBe(false)
    expect(h.state.attrs.value(resource, 'amount').toNumber()).toBe(42)
    expect(h.state.diagnosticCount('E_ASSIGN_TYPE')).toBe(2)
  })

  it('`amount` 写入经 `clampLower0`：负值夹到 0（4.4 第 2 条）', () => {
    const h = full()
    const resource = h.state.attrs.require('res.r1')
    h.state.attrs.write('res.r1.amount', Num.fromNumber(-5), '<test>')
    expect(h.state.attrs.value(resource, 'amount').toNumber()).toBe(0)
    expect(h.state.diagnosticCount('E_UNDERFLOW')).toBe(1)
  })

  it('`NaN` **不做隐式兜底**，原样传播（4.4：`clampLower0` 只夹下溢）', () => {
    // 这是一条刻意保留的行为：`NaN` 若被悄悄换成 0，作者写错的表达式就会变成
    // “看起来在跑但数值不对”的静默故障。传播出去反而能被依赖它的路径暴露出来。
    const h = full()
    const resource = h.state.attrs.require('res.r1')
    h.state.attrs.writeQuantity(resource, 'amount', Num.fromNumber(NaN), 'res.r1.amount', '<test>')
    expect(h.state.attrs.value(resource, 'amount').isNan()).toBe(true)
  })

  it('`effectValues[i]` 只接受数值，写字符串报 `E_ASSIGN_TYPE`', () => {
    const h = full()
    const upgrade = h.upgrade('u1')
    expect(h.state.attrs.write('up.u1.effectValues[0]', Num.fromNumber(3), '<test>')).toBe(true)
    expect(h.state.attrs.value(upgrade, 'effectValues[0]').toNumber()).toBe(3)
    expect(h.state.attrs.write('up.u1.effectValues[0]', '"hello"', '<test>')).toBe(false)
    expect(h.state.attrs.value(upgrade, 'effectValues[0]').toNumber()).toBe(3)
    expect(h.state.diagnosticCount('E_ASSIGN_TYPE')).toBe(1)
  })
})

describe('5.9.3 ③ 布尔 / 字符串 / 表达式文本', () => {
  it('布尔字段接受布尔值与 `"true"`/`"false"` 两种形态', () => {
    const h = full()
    // 布尔字段的**唯一**公开读路径是 `judge` 与 `readAttr`：
    // `attrs.value()` 是“直接存储的数值”访问器（`amount/bought/owned/effectValues[i]`），
    // 布尔字段不走它——它不是 `values` 里的数字。
    expect(h.state.judge.isVisible(h.generator('g1'))).toBe(true)
    expect(h.state.attrs.write('gen.g1.visible', false, '<test>')).toBe(true)
    expect(h.state.judge.isVisible(h.generator('g1'))).toBe(false)
    expect(h.state.attrs.write('gen.g1.visible', 'true', '<test>')).toBe(true)
    expect(h.state.judge.isVisible(h.generator('g1'))).toBe(true)
    expect(h.state.attrs.write('gen.g1.disabled', 'true', '<test>')).toBe(true)
    expect(h.state.judge.isDisabled(h.generator('g1'))).toBe(true)
    expect(h.state.attrs.write('gen.g1.isClicker', true, '<test>')).toBe(true)
    expect(h.state.judge.isClicker(h.generator('g1'))).toBe(true)
  })

  it('`perSecond` 布尔字段可写，且只对升级生效', () => {
    const h = full()
    expect(upgradeDefPerSecond(h.upgrade('u1'))).toBe(false)
    expect(h.state.attrs.write('up.u1.perSecond', 'true', '<test>')).toBe(true)
    expect(upgradeDefPerSecond(h.upgrade('u1'))).toBe(true)
  })

  it('布尔字段写数字 `0`/`1` 被拒（PRD 补充 6），且状态不变', () => {
    const h = full()
    expect(h.state.attrs.write('gen.g1.visible', '1', '<test>')).toBe(false)
    expect(h.state.attrs.write('gen.g1.visible', '0', '<test>')).toBe(false)
    expect(h.state.diagnosticCount('E_ASSIGN_TYPE')).toBe(2)
    // 状态未被改动（仍是项目文件里的 `visible: true`）。
    expect(h.state.judge.isVisible(h.generator('g1'))).toBe(true)
  })

  it('`description` 是字符串：接受任意字符串，拒绝布尔', () => {
    const h = full()
    const generator = h.generator('g1')
    expect(h.state.attrs.write('gen.g1.description', '改过', '<test>')).toBe(true)
    expect(h.state.attrs.textOr(generator, 'description')).toBe('改过')
    expect(h.state.attrs.write('gen.g1.description', true, '<test>')).toBe(false)
    expect(h.state.attrs.textOr(generator, 'description')).toBe('改过')
  })

  it('`materialId` 指向不存在的资源时拒写并记 `E_DANGLING_REF`（写入期校验）', () => {
    const h = full()
    expect(h.state.attrs.write('gen.g1.costs[0].materialId', 'r404', '<test>')).toBe(false)
    expect(h.state.attrs.textOr(h.generator('g1'), 'costs[0].materialId')).toBe('r1')
    expect(h.state.diagnosticCount('E_DANGLING_REF')).toBe(1)
    // 换成真实资源即可。
    expect(h.state.attrs.write('gen.g1.costs[0].materialId', 'r1', '<test>')).toBe(true)
  })
})

describe('`res.<id>.owned` 别名（5.9.1 第 8 行、D-37）', () => {
  it('与 `amount` 是同一处存储：写其一即改其二', () => {
    const h = full()
    const resource = h.state.attrs.require('res.r1')
    h.state.attrs.write('res.r1.owned', Num.fromNumber(77), '<test>')
    expect(h.state.attrs.value(resource, 'amount').toNumber()).toBe(77)
    expect(h.state.attrs.value(resource, 'owned').toNumber()).toBe(77)
    h.state.attrs.write('res.r1.amount', Num.fromNumber(5), '<test>')
    expect(h.state.attrs.value(resource, 'owned').toNumber()).toBe(5)
  })

  it('别名写入同样走 `max` 钳制', () => {
    const h = full()
    h.state.attrs.write('res.r1.max', '10', '<test>')
    h.state.attrs.write('res.r1.owned', Num.fromNumber(99), '<test>')
    expect(h.state.attrs.value(h.state.attrs.require('res.r1'), 'amount').toNumber()).toBe(10)
  })

  it('别名**不单独存档**（6.3）：attrs 里没有第二处存储', () => {
    const h = full()
    const resource = h.state.attrs.require('res.r1')
    h.state.attrs.write('res.r1.owned', Num.fromNumber(9), '<test>')
    expect(resource.values.has('amount')).toBe(true)
    expect(resource.values.has('owned')).toBe(false)
  })

  it('`gen.<id>.owned` 不受别名影响（它就是自己的字段）', () => {
    const h = full()
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(4), '<test>')
    expect(h.generator('g1').values.has('owned')).toBe(true)
    expect(h.generator('g1').values.has('amount')).toBe(false)
  })
})

describe('只读目标（5.9 第 2 组、13 第 1 组、`E_READONLY_TARGET`）', () => {
  const readonlyKeys = [
    'res.r1.id',
    'gen.g1.order',
    'gen.g1.perSec',
    'gen.g1.buyDelay',
    'up.u1.buyDelay',
    'page.p1.theme',
    'page.p1.columns',
    'page.p1.entries',
  ]

  it.each(readonlyKeys)('%s 写入报 `E_READONLY_TARGET`', (key) => {
    const h = full()
    expect(h.state.attrs.write(key, 'x', '<test>')).toBe(false)
    expect(h.state.diagnosticCount('E_READONLY_TARGET')).toBe(1)
  })

  it('只读属性**可以读**：`perSec` / `buyDelay` / `entries` 有真实值', () => {
    const h = full()
    const generator = h.generator('g1')
    // `perSec` 是**派生量** = `owned × Σ produces[i].amount`（5.9.1 第 9 行），不是项目文件字段。
    expect(h.state.attrs.perSecond(generator).toNumber()).toBe(0)
    h.state.attrs.write('gen.g1.owned', Num.fromNumber(3), '<test>')
    expect(h.state.attrs.perSecond(generator).toNumber()).toBe(3)
    expect(h.state.attrs.textOr(generator, 'buyDelay')).toBe('1')
    // `entries` 是布局列表，表达式侧只暴露长度（13 第 2 条）。
    // 用表达式求值来读：列表字段不经 `attrs.value()`（那是直接存储的数值访问器）。
    expect(h.state.runtime.evaluateNumber('page.p1.entries', 'condition', '<test>').toNumber()).toBe(3)
  })

  it('写入不存在的条目报 `E_UNKNOWN_ATTR`', () => {
    const h = full()
    expect(h.state.attrs.write('gen.g404.bought', Num.fromNumber(1), '<test>')).toBe(false)
    expect(h.state.diagnosticCount('E_UNKNOWN_ATTR')).toBe(1)
  })

  it('生成器/升级没有 `amount`（D-20），读写都报 `E_UNKNOWN_ATTR`', () => {
    const h = full()
    expect(h.state.attrs.write('gen.g1.amount', Num.fromNumber(1), '<test>')).toBe(false)
    expect(() => h.state.attrs.value(h.generator('g1'), 'amount')).toThrowError(/E_UNKNOWN_ATTR|amount/)
  })
})

describe('内置变量（5.2、8.3）', () => {
  it('`tick` / `time` / `dt` / `elapsed` / `offline` / `started` 可在表达式里读到', () => {
    const h = full()
    h.runTicks(5)
    // 拿一个 `price` 上下文的字段当探针：把 `costs[0].amount` 的文本换成变量名，
    // 再走 `evaluateCostAt` —— 它是生产代码里读 `costs[i].amount` 的那条路径，
    // 因此断言的是「内置变量在表达式里可读」，而不是直接调 `evaluateNumber`
    //（后者不经过 `AttributeStore` 的 read，也就测不到内置变量接线）。
    const priceOf = (variable: string): number => {
      expect(h.state.attrs.write('gen.g1.costs[0].amount', variable, '<test>'), variable).toBe(true)
      return evaluateCostAt(h.state, h.generator('g1'), N.fromNumber(0)).quotes[0]!.price.toNumber()
    }
    expect(priceOf('tick')).toBe(5)
    expect(priceOf('elapsed')).toBeGreaterThan(0)
    expect(priceOf('dt')).toBeGreaterThan(0)
    expect(priceOf('offline')).toBe(0)
    expect(priceOf('started')).toBeGreaterThan(0)
  })

  it('内置变量不可写（`write` 走的是条目路径，因此报 `E_UNKNOWN_ATTR`）', () => {
    const h = full()
    expect(h.state.attrs.write('tick', Num.fromNumber(1), '<test>')).toBe(false)
    expect(h.state.diagnosticCount('E_UNKNOWN_ATTR')).toBe(1)
    // `write` 的契约是“写某个条目的属性”，内置变量没有所属条目——这是**不可写**的
    // 另一条路径，与 `E_READONLY_TARGET`（条目内只读属性）分开报，便于定位作者写错了什么。
  })
})

describe('tick 缓存的写入失效（8.3 第 1 步 / 12 性能预算）', () => {
  it('写入之后，同一 tick 内再次求值读到的是**新**值', () => {
    const h = full()
    const read = (): number => evaluateCostAt(h.state, h.generator('g1'), N.fromNumber(0)).quotes[0]!.price.toNumber()
    const before = read()
    // 同一 tick 内写入（没有 `stepTick` 清缓存）。
    h.state.attrs.write('res.r1.amount', Num.fromNumber(1000), '<test>')
    h.state.attrs.writeText(h.generator('g1'), 'costs[0].amount', '100 * res.r1.amount', '<test>')
    // 价格字段本身被热替换，`price` 上下文的缓存键含文本哈希，本来就会重算；
    // 真正要验证的是**依赖的存储**变了之后，缓存也要失效。
    expect(read()).not.toBe(before)
    expect(read()).toBe(100 * 1000)
  })

  it('写入 `bought` 之后，同一 tick 内的升级条件立即反映新值（自动购买阶段依赖它）', () => {
    const project = assignToPage(createExampleProject(), 'p1', ['r1', 'g1', 'u1'])
    const h = new Harness({ project })
    const upgrade = h.upgrade('u1')
    const canBuyNow = (): boolean => h.state.judge.canBuy(upgrade)
    expect(canBuyNow(), '条件为 `gen.g1.bought >= 5`').toBe(false)
    // 不跑 tick，直接写 `bought`——如果缓存不失效，这里会一直读到旧值。
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), '<test>')
    expect(canBuyNow()).toBe(true)
  })

  it('缓存只在“无写入”期间生效：连续两次读同一表达式只算一次', () => {
    const h = full()
    const generator = h.generator('g1')
    h.runTicks(1)
    const before = h.state.runtime.evaluations()
    h.state.runtime.evaluateNumber('1 + 1', 'field', '<test>')
    const afterFirst = h.state.runtime.evaluations()
    h.state.runtime.evaluateNumber('1 + 1', 'field', '<test>')
    const afterSecond = h.state.runtime.evaluations()
    expect(afterFirst - before).toBe(1)
    expect(afterSecond).toBe(afterFirst)
    void generator
  })
})

describe('写入记录与缓存版本（5.9.3 第 1 条、6.3）', () => {
  it('写表达式文本会记 `assignments`（键是完整路径，值为 value/expr/tick）', () => {
    const h = full()
    h.runTicks(3)
    h.state.attrs.write('gen.g1.costs[0].amount', '10 * 1.15 ^ gen.g1.bought', 'gen.g1.bought >= 3')
    const record = h.generator('g1').assignments.get('gen.g1.costs[0].amount')
    expect(record?.value).toBe('10 * 1.15 ^ gen.g1.bought')
    expect(record?.expr).toBe('gen.g1.bought >= 3')
    expect(record?.tick).toBe(3)
  })

  it('写数值字段**也**记 `assignments`（6.3：数值权威字段的赋值同样留痕）', () => {
    const h = full()
    h.runTicks(2)
    h.state.attrs.write('gen.g1.bought', Num.fromNumber(5), 'set("gen.g1.bought", "5")')
    const record = h.generator('g1').assignments.get('gen.g1.bought')
    expect(record?.value).toBe('5')
    expect(record?.expr).toBe('set("gen.g1.bought", "5")')
    expect(record?.tick).toBe(2)
  })

  it('`versionOf` 在写入后递增，供 UI 缓存失效用', () => {
    const h = full()
    const key = 'gen.g1.bought'
    const before = h.state.attrs.versionOf(key)
    h.state.attrs.write(key, Num.fromNumber(1), '<test>')
    expect(h.state.attrs.versionOf(key)).toBeGreaterThan(before)
  })

  it('`versionOf` 对 `res.<id>.owned` 与 `amount` 返回同一个版本（别名共享存储）', () => {
    const h = full()
    h.state.attrs.write('res.r1.owned', Num.fromNumber(1), '<test>')
    expect(h.state.attrs.versionOf('res.r1.owned')).toBe(h.state.attrs.versionOf('res.r1.amount'))
  })
})
