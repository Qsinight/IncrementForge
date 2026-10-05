/**
 * 静态检查用例（TECH_DESIGN 5.5 权限表、5.9 属性读写矩阵、5.4 末段、6.5 字段映射）。
 *
 * 覆盖 14.2 中属于编译期的用例：
 * - 价格表达式使用随机函数 -> `E_RAND_DISABLED`（PRD 补充 1）；
 * - 写只读属性 -> `E_READONLY_TARGET`（含 14.2 明列的 `perSec` 与 `page.columns`）；
 * - 赋值类型不匹配 -> `E_ASSIGN_TYPE`；
 * - `set()` 路径非字面量 -> 拒绝（D-27）；
 * - `create()` 的 spec 校验 -> `E_CREATE_FIELD_INVALID` / `E_CREATE_NO_PAGE`；
 * - 引用不存在的属性 -> `E_UNKNOWN_ATTR`。
 */
import { describe, expect, it } from 'vitest'
import { ForgeError } from '@iforge/num'

import { staticCheck } from '../src/checker.js'
import { parse } from '../src/parser.js'

/** 在指定上下文中编译，断言抛出某错误码。 */
function expectCode(text: string, context: Parameters<typeof staticCheck>[1], code: string): ForgeError {
  let thrown: unknown
  try {
    staticCheck(parse(text), context)
  } catch (error) {
    thrown = error
  }
  expect(thrown, `期望抛出 ${code}，但编译通过`).toBeInstanceOf(ForgeError)
  expect((thrown as ForgeError).code).toBe(code)
  return thrown as ForgeError
}

/** 断言编译通过。 */
function expectOk(text: string, context: Parameters<typeof staticCheck>[1]): void {
  expect(() => staticCheck(parse(text), context)).not.toThrow()
}

describe('5.5 上下文：随机函数（PRD 补充 1）', () => {
  it('价格上下文编译期报 E_RAND_DISABLED', () => {
    expectCode('rand()', 'price', 'E_RAND_DISABLED')
    expectCode('randInt(1, 10)', 'price', 'E_RAND_DISABLED')
    expectCode('randChance(0.5)', 'price', 'E_RAND_DISABLED')
    expectCode('10 * (1 + rand())', 'price', 'E_RAND_DISABLED')
  })

  it('其它上下文允许随机函数', () => {
    expectOk('rand()', 'field')
    expectOk('rand()', 'production')
    expectOk('rand()', 'condition')
    expectOk('rand()', 'effect')
  })
})

describe('5.5 上下文：副作用函数', () => {
  it('非 effect 上下文报 E_SIDE_EFFECT_FORBIDDEN', () => {
    expectCode('set("gen.g1.bought", 1)', 'price', 'E_SIDE_EFFECT_FORBIDDEN')
    expectCode('set("gen.g1.bought", 1)', 'production', 'E_SIDE_EFFECT_FORBIDDEN')
    expectCode('set("gen.g1.bought", 1)', 'condition', 'E_SIDE_EFFECT_FORBIDDEN')
    expectCode('set("gen.g1.bought", 1)', 'field', 'E_SIDE_EFFECT_FORBIDDEN')
    expectCode('destroy("u1")', 'condition', 'E_SIDE_EFFECT_FORBIDDEN')
  })

  it('effect 上下文允许副作用函数', () => {
    expectOk('set("gen.g1.bought", 1)', 'effect')
    expectOk('destroy("u1")', 'effect')
  })
})

describe('5.9 只读属性（14.2 明列用例）', () => {
  it('写派生属性 perSec 报 E_READONLY_TARGET', () => {
    expectCode('gen.g1.perSec = 1', 'effect', 'E_READONLY_TARGET')
  })

  it('写页面布局属性 columns 报 E_READONLY_TARGET', () => {
    expectCode('page.p1.columns = 3', 'effect', 'E_READONLY_TARGET')
  })

  it('id / order / name / icon 一律只读', () => {
    expectCode('gen.g1.id = "g2"', 'effect', 'E_READONLY_TARGET')
    expectCode('gen.g1.order = 3', 'effect', 'E_READONLY_TARGET')
    expectCode('gen.g1.name = "x"', 'effect', 'E_READONLY_TARGET')
    expectCode('gen.g1.icon = "star"', 'effect', 'E_READONLY_TARGET')
    expectCode('page.p1.theme = "page-light"', 'effect', 'E_READONLY_TARGET')
    expectCode('page.p1.entries = 1', 'effect', 'E_READONLY_TARGET')
  })

  it('buyDelay 是实现细节只读属性', () => {
    expectCode('gen.g1.buyDelay = 5', 'effect', 'E_READONLY_TARGET')
    expectCode('up.u1.buyDelay = 5', 'effect', 'E_READONLY_TARGET')
  })

  it('set() 写只读属性同样报 E_READONLY_TARGET', () => {
    expectCode('set("gen.g1.perSec", 1)', 'effect', 'E_READONLY_TARGET')
    expectCode('set("page.p1.columns", 3)', 'effect', 'E_READONLY_TARGET')
  })

  it('只读属性仍可读', () => {
    expectOk('gen.g1.perSec', 'field')
    expectOk('page.p1.columns', 'field')
    expectOk('gen.g1.name', 'field')
  })
})

describe('5.9 可写属性（6.5 字段映射中标 ✅ 的字段）', () => {
  it('条目数值属性可写', () => {
    expectOk('gen.g1.initial = 5', 'effect')
    expectOk('gen.g1.max = 100', 'effect')
    expectOk('gen.g1.bought = 3', 'effect')
    expectOk('gen.g1.owned = 3', 'effect')
    expectOk('gen.g1.buyAmount = 10', 'effect')
    expectOk('res.r1.amount = 10', 'effect')
    expectOk('up.u1.effectValues[0] = 3', 'effect')
  })

  it('布尔属性可写', () => {
    expectOk('gen.g1.visible = true', 'effect')
    expectOk('gen.g1.disabled = false', 'effect')
    expectOk('gen.g1.isClicker = true', 'effect')
    expectOk('up.u1.perSecond = true', 'effect')
    expectOk('page.p1.visible = true', 'effect')
  })

  it('字符串与表达式文本属性可写', () => {
    expectOk('gen.g1.description = "强化"', 'effect')
    expectOk('gen.g1.costs[0].materialId = "r2"', 'effect')
    expectOk('gen.g1.costs[0].amount = "20"', 'effect')
    expectOk('gen.g1.produces[0].amount = "2"', 'effect')
    expectOk('up.u1.conditions[0] = "true"', 'effect')
    expectOk('up.u1.effects[0].action = "effValue = 1"', 'effect')
  })

  it('res.owned 是 amount 的读写别名（D-37）', () => {
    expectOk('res.r1.owned = 10', 'effect')
    expect(staticCheck(parse('res.r1.owned'), 'field').type).toBe('number')
  })

  it('effValue 只在 effect 上下文可用（5.3）', () => {
    expectOk('effValue = 3', 'effect')
    expectCode('effValue = 3', 'condition', 'E_UNKNOWN_IDENT')
    expectCode('effValue + 1', 'price', 'E_UNKNOWN_IDENT')
  })
})

describe('5.9.3 赋值类型', () => {
  it('布尔属性赋非布尔值报 E_ASSIGN_TYPE', () => {
    expectCode('gen.g1.visible = 1', 'effect', 'E_ASSIGN_TYPE')
    expectCode('gen.g1.visible = "true"', 'effect', 'E_ASSIGN_TYPE')
    expectCode('set("gen.g1.disabled", 0)', 'effect', 'E_ASSIGN_TYPE')
  })

  it('字符串属性赋非字符串报 E_ASSIGN_TYPE', () => {
    expectCode('gen.g1.description = 5', 'effect', 'E_ASSIGN_TYPE')
  })

  it('布尔 / null 赋给数值或表达式文本属性报 E_ASSIGN_TYPE（5.9.3 表）', () => {
    expectCode('gen.g1.initial = true', 'effect', 'E_ASSIGN_TYPE')
    expectCode('gen.g1.initial = null', 'effect', 'E_ASSIGN_TYPE')
    expectCode('up.u1.effectValues[0] = true', 'effect', 'E_ASSIGN_TYPE')
  })

  it('effValue 只接受数值', () => {
    expectCode('effValue = "3"', 'effect', 'E_ASSIGN_TYPE')
    expectCode('effValue = true', 'effect', 'E_ASSIGN_TYPE')
  })

  it('复合赋值受同一条类型约束', () => {
    expectOk('gen.g1.bought += 1', 'effect')
    expectOk('gen.g1.bought *= 2', 'effect')
    expectOk('gen.g1.bought -= 1', 'effect')
    expectOk('gen.g1.bought /= 2', 'effect')
  })
})

describe('5.9.3 不存在的属性', () => {
  it('资源无 bought / disabled（D-20、PRD 未定义资源的禁用态）', () => {
    expectCode('res.r1.bought', 'field', 'E_UNKNOWN_ATTR')
    expectCode('res.r1.disabled', 'field', 'E_UNKNOWN_ATTR')
    expectCode('res.r1.bought = 1', 'effect', 'E_UNKNOWN_ATTR')
  })

  it('升级无 produces、生成器无 conditions / effects / perSecond', () => {
    expectCode('up.u1.produces[0].amount', 'field', 'E_UNKNOWN_ATTR')
    expectCode('gen.g1.conditions[0]', 'field', 'E_UNKNOWN_ATTR')
    expectCode('gen.g1.effects[0].condition', 'field', 'E_UNKNOWN_ATTR')
    expectCode('gen.g1.perSecond', 'field', 'E_UNKNOWN_ATTR')
    expectCode('up.u1.produces[0].amount', 'field', 'E_UNKNOWN_ATTR')
  })

  it('资源无 isClicker / perSecond / buyAmount', () => {
    expectCode('res.r1.isClicker', 'field', 'E_UNKNOWN_ATTR')
    expectCode('res.r1.perSecond', 'field', 'E_UNKNOWN_ATTR')
    expectCode('res.r1.buyAmount', 'field', 'E_UNKNOWN_ATTR')
  })
})

describe('5.4 / 5.9.3：set() 的字面量路径（D-27）', () => {
  it('路径必须是字面量字符串，不接受变量或拼接', () => {
    expectCode('set(gen.g1.bought, 1)', 'effect', 'E_TYPE')
    // 语言无字符串拼接，`"gen." + "g1.bought"` 本身就报 E_TYPE（17.2 / R-27 的同类断言）。
    expectCode('set("gen." + "g1.bought", 1)', 'effect', 'E_TYPE')
  })

  it('路径不存在报 E_UNKNOWN_ATTR', () => {
    expectCode('set("gen.g1.nope", 1)', 'effect', 'E_UNKNOWN_ATTR')
  })

  it('合法的字面量路径通过', () => {
    expectOk('set("gen.g1.costs[0].amount", "2")', 'effect')
    expectOk('set("res.r1.amount", 10)', 'effect')
    expectOk('set("up.u1.effectValues[0]", 1.5)', 'effect')
  })
})

describe('8.7 create() 的 spec 校验', () => {
  it('缺 page 报 E_CREATE_NO_PAGE（PRD 补充 7、D-09）', () => {
    expectCode('create("upgrade", { name: "x" })', 'effect', 'E_CREATE_NO_PAGE')
  })

  it('未知键报 E_CREATE_FIELD_INVALID', () => {
    expectCode('create("upgrade", { name: "x", page: "p1", bogus: 1 })', 'effect', 'E_CREATE_FIELD_INVALID')
  })

  it('kind / buyDelay 由运行时接管，出现在 spec 中报错', () => {
    expectCode('create("upgrade", { page: "p1", kind: "upgrade" })', 'effect', 'E_CREATE_FIELD_INVALID')
    expectCode('create("upgrade", { page: "p1", buyDelay: 5 })', 'effect', 'E_CREATE_FIELD_INVALID')
  })

  it('跨类字段不合法（生成器不能有 conditions）', () => {
    expectCode('create("generator", { page: "p1", conditions: ["true"] })', 'effect', 'E_CREATE_FIELD_INVALID')
    expectCode('create("upgrade", { page: "p1", produces: [] })', 'effect', 'E_CREATE_FIELD_INVALID')
  })

  it('kind 只能是 generator / upgrade（D-34）', () => {
    expectCode('create("resource", { page: "p1" })', 'effect', 'E_CREATE_FIELD_INVALID')
  })

  it('数值/表达式字段必须传字符串（8.7「字段形态」行）', () => {
    expectCode('create("upgrade", { page: "p1", costs: [{ materialId: "r1", amount: 10 }] })', 'effect', 'E_CREATE_FIELD_INVALID')
    expectCode('create("upgrade", { page: "p1", initial: 5 })', 'effect', 'E_CREATE_FIELD_INVALID')
  })

  it('合法 spec 通过', () => {
    expectOk('create("upgrade", { id: "uTmp", name: "x", page: "p1", costs: [{ materialId: "r1", amount: "10" }], conditions: ["true"] })', 'effect')
    expectOk('create("generator", { name: "x", page: "p1", produces: [{ materialId: "r1", amount: "1" }] })', 'effect')
  })

  it('完整示例项目中的动态创建写法可编译（17.2 片段 ②）', () => {
    expectOk(
      'create("upgrade", { id: "uTmp", name: "临时强化", description: "动态条目，不进项目文件", page: "p1", initial: "0", max: "1", costs: [{ materialId: "r1", amount: "50" }], conditions: ["true"] })',
      'effect',
    )
  })
})

describe('5.3 内置变量与未知标识符', () => {
  it('内置变量可读', () => {
    expectOk('tick', 'field')
    expectOk('time', 'field')
    expectOk('dt', 'field')
    expectOk('elapsed', 'field')
    expectOk('offline', 'field')
    expectOk('started', 'field')
    expect(staticCheck(parse('offline'), 'field').type).toBe('boolean')
    expect(staticCheck(parse('tick'), 'field').type).toBe('number')
  })

  it('未知标识符报 E_UNKNOWN_IDENT', () => {
    expectCode('unknownVar', 'field', 'E_UNKNOWN_IDENT')
    expectCode('unknownFunc(1)', 'field', 'E_UNKNOWN_IDENT')
  })
})

describe('5.2 字符串不参与算术', () => {
  it('字符串参与算术报 E_TYPE（语言无 str() 与拼接，R-27）', () => {
    expectCode('"2" + 1', 'effect', 'E_TYPE')
    expectCode('"2" + gen.g1.owned', 'effect', 'E_TYPE')
    expectCode('1 + "a"', 'effect', 'E_TYPE')
  })

  it('函数实参传字符串也报 E_TYPE', () => {
    expectCode('floor("5")', 'field', 'E_TYPE')
    expectCode('min("1", 2)', 'field', 'E_TYPE')
  })
})

describe('5.6 变量解析与 deps', () => {
  it('deps 收集全部被引用的属性键（5.6）', () => {
    const result = staticCheck(parse('gen.g1.bought + res.r1.amount * 2'), 'price')
    expect(result.deps).toEqual(['gen.g1.bought', 'res.r1.amount'])
  })

  it('deps 去重', () => {
    const result = staticCheck(parse('gen.g1.bought + gen.g1.bought'), 'price')
    expect(result.deps).toEqual(['gen.g1.bought'])
  })

  it('set() 的目标路径也进入 deps', () => {
    const result = staticCheck(parse('set("gen.g1.bought", 1)'), 'effect')
    expect(result.deps).toContain('gen.g1.bought')
  })

  it('hasEffect 标识是否含副作用调用（8.8 离线可达性、D-08 静态环）', () => {
    expect(staticCheck(parse('set("gen.g1.bought", 1)'), 'effect').hasEffect).toBe(true)
    expect(staticCheck(parse('destroy("u1")'), 'effect').hasEffect).toBe(true)
    expect(staticCheck(parse('gen.g1.bought + 1'), 'price').hasEffect).toBe(false)
  })

  it('静态类型推导', () => {
    expect(staticCheck(parse('1 + 2'), 'field').type).toBe('number')
    expect(staticCheck(parse('1 < 2'), 'field').type).toBe('boolean')
    expect(staticCheck(parse('gen.g1.visible'), 'field').type).toBe('boolean')
    expect(staticCheck(parse('gen.g1.description'), 'field').type).toBe('string')
  })
})

describe('5.4 arity', () => {
  it('实参个数不符报 E_PARSE', () => {
    expectCode('floor()', 'field', 'E_PARSE')
    expectCode('floor(1, 2)', 'field', 'E_PARSE')
    expectCode('clamp(1)', 'field', 'E_PARSE')
  })

  it('变参函数接受多个实参', () => {
    expectOk('min(1, 2, 3)', 'field')
    expectOk('max(1, 2, 3, 4)', 'field')
  })
})
