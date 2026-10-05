/**
 * 属性键的构造与解析（TECH_DESIGN 5.6「变量解析」、5.9、8.4）。
 *
 * `keys.ts` 是运行时侧构造 path key 的**唯一**入口，必须与 `expr` 侧
 * （编译器 / 检查器 / `set()`）生成的键**逐字一致**——一旦两边格式分叉，
 * 副作用就会写到另一个键上，而这类偏差在数值上表现为“`set()` 了但没生效”。
 *
 * 因此本文件除了逐个键构造器做断言，还固定三条跨包不变式：
 * 1. `Keys.*` 产出的键能被 `parseKey` **原样**解回同一属性（构造/解析互逆）；
 * 2. 列表属性一律用 `costs[0]` 形态而非 `costs.0`（5.9 `formatPathKey` 注释）；
 * 3. `PREFIX_TO_KIND` / `KIND_TO_PREFIX` 与 `CREATE_KINDS` 三个映射自洽。
 */
import { describe, expect, it } from 'vitest'

import { Diagnostics, resetDiagnostics } from '@iforge/num'
import {
  BUILTIN_VARIABLES,
  CREATE_KINDS,
  Keys,
  KIND_TO_PREFIX,
  PREFIX_TO_KIND,
  entityKey,
  formatPathKey,
  isBuiltinVariable,
  parseKey,
  parseLiteralPath,
  templateKey,
} from '../src/keys.js'

describe('entityKey()：不带属性的条目主键', () => {
  it('四种前缀都产出 `<prefix>.<id>`', () => {
    expect(entityKey('res', 'r1')).toBe('res.r1')
    expect(entityKey('gen', 'g1')).toBe('gen.g1')
    expect(entityKey('up', 'u1')).toBe('up.u1')
    expect(entityKey('page', 'p1')).toBe('page.p1')
  })

  it('转发给 formatPathKey，空属性链不加尾点', () => {
    expect(entityKey('gen', 'g7')).toBe(formatPathKey('gen', 'g7', []))
    // 不应出现 `gen.g7.` 这种尾点。
    expect(entityKey('gen', 'g7')).not.toMatch(/\.$/)
  })
})

describe('parseKey()：解析属性键（8.4 的 pageOf 与副作用提交都靠它反查）', () => {
  it('解析普通属性：无下标时 index 为 undefined', () => {
    const parsed = parseKey('gen.g1.amount')
    expect(parsed).toBeDefined()
    expect(parsed!.prefix).toBe('gen')
    expect(parsed!.kind).toBe('generator')
    expect(parsed!.id).toBe('g1')
    expect(parsed!.attr).toBe('amount')
    expect(parsed!.concreteAttr).toBe('amount')
    expect(parsed!.index).toBeUndefined()
  })

  it('解析列表属性：拆出具体下标并给出模板键（D-37 查表靠 attr）', () => {
    const parsed = parseKey('gen.g1.costs[0].amount')
    expect(parsed).toBeDefined()
    expect(parsed!.id).toBe('g1')
    // 模板键用于查属性表（登记形态是 `costs[i].amount`）。
    expect(parsed!.attr).toBe('costs[i].amount')
    // 具体键用于 deps 缓存与副作用目标。
    expect(parsed!.concreteAttr).toBe('costs[0].amount')
    expect(parsed!.index).toBe(0)
  })

  it('解析无尾属性名的列表属性：`effectValues[2]`', () => {
    const parsed = parseKey('up.u1.effectValues[2]')
    expect(parsed!.attr).toBe('effectValues[i]')
    expect(parsed!.concreteAttr).toBe('effectValues[2]')
    expect(parsed!.index).toBe(2)
    expect(parsed!.kind).toBe('upgrade')
  })

  it('多位数下标按整数解析', () => {
    expect(parseKey('gen.g1.costs[12].amount')!.index).toBe(12)
  })

  it('解析页面属性', () => {
    const parsed = parseKey('page.p1.columns')
    expect(parsed!.prefix).toBe('page')
    expect(parsed!.kind).toBe('page')
    expect(parsed!.id).toBe('p1')
    expect(parsed!.attr).toBe('columns')
  })

  it('非路径键返回 undefined（内置变量、畸形输入）', () => {
    // 内置变量不带前缀（5.3）。
    expect(parseKey('tick')).toBeUndefined()
    expect(parseKey('time')).toBeUndefined()
    // 条目主键不带属性链，不满足字面量路径文法。
    expect(parseKey('res.r1')).toBeUndefined()
    expect(parseKey('res.r1.')).toBeUndefined()
    expect(parseKey('')).toBeUndefined()
    expect(parseKey('res..amount')).toBeUndefined()
    expect(parseKey('res.r1.1bad')).toBeUndefined()
    // 未知前缀。
    expect(parseKey('foo.x.amount')).toBeUndefined()
  })
})

describe('Keys.res()：资源键构造器', () => {
  const k = Keys.res('r1')

  it('逐个字段的键文本', () => {
    expect(k.entity).toBe('res.r1')
    expect(k.amount).toBe('res.r1.amount')
    expect(k.owned).toBe('res.r1.owned')
    expect(k.initial).toBe('res.r1.initial')
    expect(k.max).toBe('res.r1.max')
    expect(k.visible).toBe('res.r1.visible')
    expect(k.description).toBe('res.r1.description')
    expect(k.id).toBe('res.r1.id')
    expect(k.order).toBe('res.r1.order')
    expect(k.name).toBe('res.r1.name')
    expect(k.icon).toBe('res.r1.icon')
  })

  it('`owned` 与 `amount` 是两个独立键但同一存储（D-37 别名）', () => {
    // 别名不是同一键：查表时 `owned` 映射到 `amount` 的规格（properties.lookupProperty）。
    expect(k.owned).not.toBe(k.amount)
    expect(parseLiteralPath(k.owned)!.spec).toBe(parseLiteralPath(k.amount)!.spec)
    // 但解回的具体属性名各自保持原样，否则 write() 会写到另一处存储。
    expect(parseLiteralPath(k.owned)!.key).toBe('owned')
    expect(parseLiteralPath(k.amount)!.key).toBe('amount')
  })
})

describe('Keys.gen()：生成器键构造器', () => {
  const k = Keys.gen('g1')

  it('标量字段', () => {
    expect(k.entity).toBe('gen.g1')
    expect(k.bought).toBe('gen.g1.bought')
    expect(k.owned).toBe('gen.g1.owned')
    expect(k.initial).toBe('gen.g1.initial')
    expect(k.max).toBe('gen.g1.max')
    expect(k.visible).toBe('gen.g1.visible')
    expect(k.disabled).toBe('gen.g1.disabled')
    expect(k.description).toBe('gen.g1.description')
    expect(k.perSec).toBe('gen.g1.perSec')
    expect(k.buyDelay).toBe('gen.g1.buyDelay')
    expect(k.isClicker).toBe('gen.g1.isClicker')
    expect(k.buyAmount).toBe('gen.g1.buyAmount')
    expect(k.id).toBe('gen.g1.id')
    expect(k.order).toBe('gen.g1.order')
    expect(k.name).toBe('gen.g1.name')
    expect(k.icon).toBe('gen.g1.icon')
  })

  it('列表字段用下标形态 `costs[0]` 而非 `costs.0`', () => {
    expect(k.costMaterial(0)).toBe('gen.g1.costs[0].materialId')
    expect(k.costAmount(0)).toBe('gen.g1.costs[0].amount')
    expect(k.produceMaterial(0)).toBe('gen.g1.produces[0].materialId')
    expect(k.produceAmount(0)).toBe('gen.g1.produces[0].amount')
    // 不同下标互不相同。
    expect(k.costAmount(0)).not.toBe(k.costAmount(1))
  })
})

describe('Keys.up()：升级键构造器', () => {
  const k = Keys.up('u1')

  it('标量字段（含生成器没有的 perSecond）', () => {
    expect(k.entity).toBe('up.u1')
    expect(k.bought).toBe('up.u1.bought')
    expect(k.owned).toBe('up.u1.owned')
    expect(k.initial).toBe('up.u1.initial')
    expect(k.max).toBe('up.u1.max')
    expect(k.visible).toBe('up.u1.visible')
    expect(k.disabled).toBe('up.u1.disabled')
    expect(k.description).toBe('up.u1.description')
    expect(k.buyDelay).toBe('up.u1.buyDelay')
    expect(k.perSecond).toBe('up.u1.perSecond')
    expect(k.buyAmount).toBe('up.u1.buyAmount')
    expect(k.id).toBe('up.u1.id')
    expect(k.order).toBe('up.u1.order')
    expect(k.name).toBe('up.u1.name')
    expect(k.icon).toBe('up.u1.icon')
  })

  it('列表字段：条件无尾属性名，效果有两个子字段', () => {
    expect(k.costMaterial(0)).toBe('up.u1.costs[0].materialId')
    expect(k.costAmount(0)).toBe('up.u1.costs[0].amount')
    expect(k.condition(0)).toBe('up.u1.conditions[0]')
    expect(k.effectCondition(0)).toBe('up.u1.effects[0].condition')
    expect(k.effectAction(0)).toBe('up.u1.effects[0].action')
    expect(k.effectValue(2)).toBe('up.u1.effectValues[2]')
    expect(k.condition(0)).not.toBe(k.condition(1))
  })
})

describe('Keys.page()：页面键构造器', () => {
  const k = Keys.page('p1')

  it('页面专有字段：theme / columns / entries', () => {
    expect(k.entity).toBe('page.p1')
    expect(k.visible).toBe('page.p1.visible')
    expect(k.disabled).toBe('page.p1.disabled')
    expect(k.description).toBe('page.p1.description')
    expect(k.theme).toBe('page.p1.theme')
    expect(k.columns).toBe('page.p1.columns')
    expect(k.entries).toBe('page.p1.entries')
    expect(k.id).toBe('page.p1.id')
    expect(k.order).toBe('page.p1.order')
    expect(k.name).toBe('page.p1.name')
    expect(k.icon).toBe('page.p1.icon')
  })
})

describe('构造/解析互逆：每个 Keys 字段都能被 parseKey 原样解回', () => {
  /**
   * 这条不变式是 `keys.ts` 存在的全部理由：运行时拼出的键若解不回同一个条目与属性，
   * 副作用就会写到别处（表现为“`set()` 生效位置错位”）。
   */
  const cases: Array<{ label: string; key: string; prefix: string; kind: string; id: string; attr: string }> = [
    { label: 'res.amount', key: Keys.res('r1').amount, prefix: 'res', kind: 'resource', id: 'r1', attr: 'amount' },
    { label: 'res.owned', key: Keys.res('r1').owned, prefix: 'res', kind: 'resource', id: 'r1', attr: 'owned' },
    { label: 'gen.perSec', key: Keys.gen('g1').perSec, prefix: 'gen', kind: 'generator', id: 'g1', attr: 'perSec' },
    {
      label: 'gen.costs[0].amount',
      key: Keys.gen('g1').costAmount(0),
      prefix: 'gen',
      kind: 'generator',
      id: 'g1',
      attr: 'costs[i].amount',
    },
    {
      label: 'gen.produces[1].materialId',
      key: Keys.gen('g1').produceMaterial(1),
      prefix: 'gen',
      kind: 'generator',
      id: 'g1',
      attr: 'produces[i].materialId',
    },
    { label: 'up.perSecond', key: Keys.up('u1').perSecond, prefix: 'up', kind: 'upgrade', id: 'u1', attr: 'perSecond' },
    {
      label: 'up.conditions[0]',
      key: Keys.up('u1').condition(0),
      prefix: 'up',
      kind: 'upgrade',
      id: 'u1',
      attr: 'conditions[i]',
    },
    {
      label: 'up.effects[0].action',
      key: Keys.up('u1').effectAction(0),
      prefix: 'up',
      kind: 'upgrade',
      id: 'u1',
      attr: 'effects[i].action',
    },
    {
      label: 'up.effectValues[2]',
      key: Keys.up('u1').effectValue(2),
      prefix: 'up',
      kind: 'upgrade',
      id: 'u1',
      attr: 'effectValues[i]',
    },
    { label: 'page.columns', key: Keys.page('p1').columns, prefix: 'page', kind: 'page', id: 'p1', attr: 'columns' },
    { label: 'page.theme', key: Keys.page('p1').theme, prefix: 'page', kind: 'page', id: 'p1', attr: 'theme' },
  ]

  it.each(cases)('$label 解回同一 prefix/kind/id/attr', (c) => {
    const parsed = parseKey(c.key)
    expect(parsed, `${c.key} 应可解析`).toBeDefined()
    expect(parsed!.prefix).toBe(c.prefix)
    expect(parsed!.kind).toBe(c.kind)
    expect(parsed!.id).toBe(c.id)
    expect(parsed!.attr).toBe(c.attr)
  })

  it('模板形态与具体形态各自自洽（`[i]` 是查表形态，不是笔误）', () => {
    for (const c of cases) {
      // 模板键：用 `[i]` 重建仍是模板键 —— 属性表就是按这个形态登记的。
      expect(formatPathKey(c.prefix as 'res', c.id, templateKey(c.attr).split('.'))).toBe(`${c.prefix}.${c.id}.${c.attr}`)
      // 具体键：用具体下标重建仍是具体键 —— deps 缓存与副作用目标按这个形态寻址。
      const concrete = templateKey(c.attr).replace(/\[i\]/g, '[0]')
      expect(formatPathKey(c.prefix as 'res', c.id, concrete.split('.'))).toBe(c.key.replace(/\[\d+\]/, '[0]'))
    }
  })
})

describe('前缀 <-> 实体类型映射（5.2 path 前缀、6.3 存档容器）', () => {
  it('PREFIX_TO_KIND 与 KIND_TO_PREFIX 互逆', () => {
    for (const [prefix, kind] of Object.entries(PREFIX_TO_KIND)) {
      expect(KIND_TO_PREFIX[kind]).toBe(prefix)
    }
    for (const [kind, prefix] of Object.entries(KIND_TO_PREFIX)) {
      expect(PREFIX_TO_KIND[prefix]).toBe(kind)
    }
  })

  it('四类实体齐备', () => {
    expect(Object.keys(PREFIX_TO_KIND).sort()).toEqual(['gen', 'page', 'res', 'up'])
    expect(Object.keys(KIND_TO_PREFIX).sort()).toEqual(['generator', 'page', 'resource', 'upgrade'])
  })

  it('`create()` 只接受生成器与升级（D-34），不开放资源/页面', () => {
    expect([...CREATE_KINDS]).toEqual(['generator', 'upgrade'])
    for (const kind of CREATE_KINDS) {
      expect(KIND_TO_PREFIX[kind]).toBeDefined()
    }
  })
})

describe('内置变量（5.3）', () => {
  it('内置变量不带 res/gen/up/page 前缀，单独识别', () => {
    expect([...BUILTIN_VARIABLES]).toEqual(['tick', 'time', 'dt', 'elapsed', 'offline', 'started'])
    for (const name of BUILTIN_VARIABLES) {
      expect(isBuiltinVariable(name)).toBe(true)
      // 内置变量不是路径：parseKey 必须拒绝，否则会被当成某个条目的属性。
      expect(parseKey(name)).toBeUndefined()
    }
  })

  it('非内置名返回 false', () => {
    expect(isBuiltinVariable('res.r1.amount')).toBe(false)
    expect(isBuiltinVariable('Tick')).toBe(false)
    expect(isBuiltinVariable('')).toBe(false)
  })
})

describe('再导出的 expr 格式化工具（5.6 三处必须同源）', () => {
  it('`templateKey` 把具体下标归一为 `[i]`', () => {
    expect(templateKey('costs[0].amount')).toBe('costs[i].amount')
    expect(templateKey('effectValues[12]')).toBe('effectValues[i]')
    // 非列表键原样返回。
    expect(templateKey('amount')).toBe('amount')
  })

  it('`parseLiteralPath` 与 `formatPathKey` 对同一属性给出一致键', () => {
    const key = Keys.gen('g1').produceAmount(3)
    const literal = parseLiteralPath(key)
    expect(literal).toBeDefined()
    expect(literal!.key).toBe('produces[3].amount')
    expect(formatPathKey('gen', 'g1', literal!.attrs)).toBe(key)
  })

  it('`parseLiteralPath` 解析出属性链（含下标数段）', () => {
    expect(parseLiteralPath('gen.g1.costs[0].materialId')!.attrs).toEqual(['costs', '0', 'materialId'])
    expect(parseLiteralPath('up.u1.effects[1].action')!.attrs).toEqual(['effects', '1', 'action'])
    expect(parseLiteralPath('res.r1.amount')!.attrs).toEqual(['amount'])
  })
})

describe('副作用：键构造不产生诊断', () => {
  it('构造与解析全部键后 Diagnostics 保持干净', () => {
    resetDiagnostics()
    for (const c of [Keys.res('r1'), Keys.gen('g1'), Keys.up('u1'), Keys.page('p1')]) void c
    void entityKey('gen', 'g1')
    void parseKey('gen.g1.costs[0].amount')
    expect(Object.values(Diagnostics.countsSnapshot()).reduce((a, b) => a + b, 0)).toBe(0)
  })
})
