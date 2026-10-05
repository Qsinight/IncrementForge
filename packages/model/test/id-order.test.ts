/**
 * 条目 `id` 命名约束与排序工具（6.1、D-45、7.5、D-40、R-35）。
 */
import { describe, expect, it } from 'vitest'

import { ForgeError } from '@iforge/num'
import {
  ID_PATTERN,
  assertDynamicId,
  assertValidId,
  collectIds,
  createDefaultProject,
  createPage,
  createResource,
  hasReservedPrefix,
  insertAfter,
  isDynamicId,
  isValidId,
  moveOrder,
  nextDynamicId,
  nextId,
  normalizeOrder,
  reorderBy,
  sortByOrder,
} from '../src/index.js'

describe('静态 id 命名约束（6.1、D-45、R-35）', () => {
  it('ID_PATTERN 要求类型前缀 + 字母数字下划线，总长 <= 32', () => {
    expect(ID_PATTERN.source).toBe('^[rgup][A-Za-z0-9_]{0,31}$')
    for (const id of ['r1', 'g7', 'u23', 'p2', 'uTmp', 'g_', 'r0'.repeat(1)]) {
      expect(isValidId(id), id).toBe(true)
    }
    // 文档 14.2「静态 id 命名约束」列出的非法样本。
    for (const id of ['my-gen', 'a.b', '中文id', 'dyn_1', 'x1', `r${'1'.repeat(32)}`]) {
      expect(isValidId(id), id).toBe(false)
    }
  })

  it('dyn 是保留前缀（静态 id 不得占用，8.7 自动 id 的保证）', () => {
    expect(hasReservedPrefix('dyn_1')).toBe(true)
    expect(hasReservedPrefix('dynX')).toBe(true)
    expect(hasReservedPrefix('g1')).toBe(false)
    // `dyn_1` 本身也过不了 ID_PATTERN（首字符不在 [rgup]），两条防线叠加。
    expect(isValidId('dyn_1')).toBe(false)
    expect(isDynamicId('dyn_1')).toBe(true)
  })

  it('assertValidId 抛 E_ID_INVALID 且不自动改 id（6.4）', () => {
    expect(() => assertValidId('my-gen', 'generators[3].id')).toThrow(ForgeError)
    try {
      assertValidId('中文id', 'generators[3].id')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_ID_INVALID')
      expect((error as ForgeError).where).toBe('generators[3].id')
    }
    expect(() => assertValidId('g7')).not.toThrow()
  })

  it('create() 的 spec.id 用 E_CREATE_ID_CONFLICT 而不是 E_ID_INVALID（8.7、17.1）', () => {
    try {
      assertDynamicId('uTmp')
    } catch {
      throw new Error('uTmp 应当合法')
    }
    try {
      assertDynamicId('p1') // 前缀必须是 g/u
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_CREATE_ID_CONFLICT')
    }
  })

  it('新 id 跳过已占用的序号；动态 id 与静态 id 天然不冲突', () => {
    const taken = collectIds([{ id: 'g1' }, { id: 'g2' }, { id: 'g10' }])
    expect(nextId('g', taken)).toBe('g3')
    expect(nextId('r', taken)).toBe('r1')
    // 静态 id 永远不会是 dyn_1（ID_PATTERN），所以自动动态 id 不需要再查冲突。
    expect(nextDynamicId(taken)).toBe('dyn_1')
    expect(nextDynamicId(new Set(['dyn_1', 'dyn_2']))).toBe('dyn_3')
  })

  it('新建条目时用同一份 taken 去重，四类前缀互不干扰', () => {
    const project = createDefaultProject()
    project.resources = [createResource({ taken: new Set(), id: 'r1' })]
    const taken = collectIds(project.resources, project.generators, project.upgrades, project.pages)
    // p1 已被默认页面占用。
    expect(nextId('p', taken)).toBe('p2')
    expect(createPage({ taken, order: 2 }).order).toBe(2)
  })
})

describe('保留前缀的两道防线（8.7「不冲突」保证、R-35）', () => {
  /**
   * `assertValidId` 的检查顺序是 `ID_PATTERN` -> `hasReservedPrefix`。
   *
   * 由于 `ID_PATTERN` 要求首字符 ∈ `[rgup]`，而保留前缀是 `dyn`（首字符 `d`），
   * **不存在**同时满足两者的 id——因此“保留前缀”那条分支在当前 `ID_PATTERN` 下不可达，
   * 它只是纵深防御（若将来放开 `ID_PATTERN` 仍能拦住）。
   * 这里如实固定现状，而不是伪造一条进不去的输入。
   */
  it('`dyn` 开头的 id 被 `ID_PATTERN` 先行拦下（保留前缀分支是不可达的纵深防御）', () => {
    for (const id of ['dyn_1', 'dynX', 'dynamic']) {
      expect(isValidId(id), id).toBe(false)
      expect(hasReservedPrefix(id), id).toBe(true)
      expect(() => assertValidId(id, 'resources[0].id')).toThrow(ForgeError)
    }
    try {
      assertValidId('dyn_1', 'resources[0].id')
    } catch (error) {
      // 报的是“不合规（正则）”，而不是“以保留前缀开头”——因为正则检查在前。
      expect((error as ForgeError).code).toBe('E_ID_INVALID')
      expect((error as ForgeError).where).toBe('resources[0].id')
      expect((error as ForgeError).message).toContain(ID_PATTERN.source)
    }
  })

  it('`hasReservedPrefix` 对普通 id 为假（保留前缀判定本身可用）', () => {
    expect(hasReservedPrefix('g1')).toBe(false)
    expect(hasReservedPrefix('uTmp')).toBe(false)
    // `gdyn_1` **不**以 `dyn` 开头（首字符是 `g`），所以它是合法静态 id。
    expect(hasReservedPrefix('gdyn_1')).toBe(false)
    expect(isValidId('gdyn_1')).toBe(true)
  })

  it('`assertDynamicId` 的顺序：先看 `[gu]` 前缀，再看整体合法性', () => {
    // `d` 开头 -> 前缀那条拦下。
    for (const id of ['dyn_1', 'p1', 'r1']) {
      try {
        assertDynamicId(id)
        throw new Error(`${id} 应当被拒`)
      } catch (error) {
        expect((error as ForgeError).code, id).toBe('E_CREATE_ID_CONFLICT')
        expect((error as ForgeError).message, id).toContain('开头')
      }
    }
    // `u` 前缀合法但整体不合法 -> 命中“非法”那条。
    for (const id of ['u-tmp', `u${'a'.repeat(40)}`, 'u中文']) {
      try {
        assertDynamicId(id)
        throw new Error(`${id} 应当被拒`)
      } catch (error) {
        expect((error as ForgeError).code, id).toBe('E_CREATE_ID_CONFLICT')
        expect((error as ForgeError).message, id).toContain('非法')
      }
    }
  })

  it('`assertDynamicId` 接受 `g`/`u` 开头的合法 id', () => {
    for (const id of ['uTmp', 'g1', 'u_' + 'a'.repeat(30)]) {
      expect(() => assertDynamicId(id), id).not.toThrow()
    }
  })

  it('两条规则的错误码不同（编辑器要区分“改项目”与“改表达式”）', () => {
    const codeOf = (fn: () => void): string => {
      try {
        fn()
        return 'NO_THROW'
      } catch (error) {
        return (error as ForgeError).code
      }
    }
    expect(codeOf(() => assertValidId('my-gen'))).toBe('E_ID_INVALID')
    expect(codeOf(() => assertDynamicId('p1'))).toBe('E_CREATE_ID_CONFLICT')
  })
})

describe('动态 id 的自动生成不会与静态 id 撞名（R-35）', () => {
  it('任意合法静态 id 都不可能是 `dyn_<n>`', () => {
    // 枚举前若干个序号，证明自动 id 与静态命名空间不相交。
    const taken = new Set(['r1', 'g1', 'u1', 'p1'])
    for (let n = 1; n <= 20; n += 1) {
      const auto = nextDynamicId(taken)
      expect(isValidId(auto), `${auto} 不应是合法静态 id`).toBe(false)
      expect(isDynamicId(auto)).toBe(true)
      taken.add(auto)
    }
  })

  it('`nextDynamicId` 跳过空洞后取最小可用序号', () => {
    expect(nextDynamicId(new Set(['dyn_2', 'dyn_3']))).toBe('dyn_1')
    expect(nextDynamicId(new Set())).toBe('dyn_1')
    expect(nextDynamicId(new Set(['dyn_1']))).toBe('dyn_2')
  })
})

describe('排序工具（7.5、D-40、PRD 补充 5）', () => {
  const items = [
    { id: 'a', order: 10 },
    { id: 'b', order: 2 },
    { id: 'c', order: 10 },
  ]

  it('sortByOrder 稳定：同 order 保持传入顺序', () => {
    expect(sortByOrder(items).map((item) => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('normalizeOrder 重排为 1..N 连续整数，不修改入参', () => {
    const result = normalizeOrder(items)
    expect(result.map((item) => item.order)).toEqual([1, 2, 3])
    expect(items.map((item) => item.order)).toEqual([10, 2, 10])
  })

  it('moveOrder 上移/下移并在边界处保持不变', () => {
    // 归一后顺序为 b(1), a(2), c(3)。
    expect(moveOrder(items, 'b', 1).map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(moveOrder(items, 'b', -1).map((i) => i.id)).toEqual(['b', 'a', 'c'])
    // 已在首位再上移：顺序不变，且 order 仍是 1..N。
    const top = normalizeOrder(items)[0]!
    expect(moveOrder(items, top.id, -1).map((i) => i.id)).toEqual(['b', 'a', 'c'])
    // 已在末位再下移同理。
    const bottom = normalizeOrder(items)[2]!
    expect(moveOrder(items, bottom.id, 1).map((i) => i.id)).toEqual(['b', 'a', 'c'])
    // 任何一次移动后 order 都是 1..N 连续整数（D-40）。
    expect(moveOrder(items, 'c', -1).map((i) => i.order)).toEqual([1, 2, 3])
  })

  it('reorderBy 按给定顺序落位，忽略多余/缺失的 id', () => {
    expect(reorderBy(items, ['c', 'zzz', 'a', 'b']).map((i) => i.id)).toEqual(['c', 'a', 'b'])
    expect(reorderBy(items, []).map((i) => i.id)).toEqual(['b', 'a', 'c'])
    expect(reorderBy(items, ['b', 'c']).map((i) => i.order)).toEqual([1, 2, 3])
  })

  it('insertAfter 把副本插到源条目之后（复制行：order 紧跟源条目）', () => {
    const clone = { id: 'b2', order: 99 }
    const result = insertAfter(items, 'b', clone)
    expect(result.map((i) => i.id)).toEqual(['b', 'b2', 'a', 'c'])
    expect(result.map((i) => i.order)).toEqual([1, 2, 3, 4])
    // 源条目不存在时追加到末尾，而不是抛错。
    expect(insertAfter(items, 'zzz', clone).at(-1)?.id).toBe('b2')
  })
})
