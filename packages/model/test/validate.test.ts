/**
 * 跨条目一致性校验与迁移（6.4、11.1 打包前检查）。
 */
import { describe, expect, it } from 'vitest'

import type { ForgeError } from '@iforge/num'
import {
  MIGRATIONS,
  createDefaultProject,
  createExampleProject,
  findStaticCycles,
  migrateProject,
  parseProjectFile,
  validateProject,
} from '../src/index.js'
import type { ProjectFile } from '../src/index.js'

function example(): ProjectFile {
  return createExampleProject()
}

describe('id 命名规范校验（6.4「id 命名规范」、D-45）', () => {
  it('逐个非法 id 报 E_ID_INVALID 并定位到具体条目路径', () => {
    const project = example()
    project.generators[0]!.id = 'my-gen'
    project.generators[1]!.id = 'a.b'
    project.upgrades[0]!.id = 'dyn_1'
    project.pages[1]!.id = 'x1'
    const issues = validateProject(project).filter((issue) => issue.code === 'E_ID_INVALID')
    expect(issues.map((issue) => issue.where).sort()).toEqual(['generators[0].id', 'generators[1].id', 'pages[1].id', 'upgrades[0].id'])
  })

  it('跨四类重名也报 E_ID_INVALID（6.1「项目内所有静态 id 全局唯一」）', () => {
    const project = example()
    project.pages[1]!.id = 'g1'
    const issues = validateProject(project).filter((issue) => issue.code === 'E_ID_INVALID')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toContain('与 generators[0].id 重复')
  })

  it('合法 id 全放行（14.2「合规 id 的表达式路径…」）', () => {
    expect(validateProject(example())).toEqual([])
  })
})

describe('引用完整性与页面唯一性（6.4、PRD 补充 7）', () => {
  it('价格材料指向不存在的资源 -> E_DANGLING_REF', () => {
    const project = example()
    project.generators[0]!.costs[0]!.materialId = 'rGone'
    const issues = validateProject(project).filter((issue) => issue.code === 'E_DANGLING_REF')
    expect(issues[0]!.where).toBe('generators[0].costs[0].materialId')
  })

  it('购买材料只指向资源；产出可指向资源或生成器（6.4「引用完整性」）', () => {
    const project = example()
    // 产出指向生成器是合法的。
    project.generators[0]!.produces.push({ materialId: 'g2', amount: '1' })
    expect(validateProject(project).filter((i) => i.code === 'E_DANGLING_REF')).toEqual([])
    // 购买材料指向生成器是**不**合法的。
    project.generators[0]!.costs.push({ materialId: 'g2', amount: '1' })
    const issues = validateProject(project).filter((i) => i.code === 'E_DANGLING_REF')
    expect(issues.map((i) => i.where)).toContain('generators[0].costs[1].materialId')
  })

  it('条目被分配到两个页面 -> E_DUPLICATE_PAGE_ENTRY 并列出全部位置', () => {
    const project = example()
    project.pages[1]!.entries.push({ id: 'r1', order: 2, theme: { kind: 'builtin', value: 'entry-dark' } })
    const issues = validateProject(project).filter((i) => i.code === 'E_DUPLICATE_PAGE_ENTRY')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toContain('pages[0].entries[0].id')
    expect(issues[0]!.message).toContain('pages[1].entries[1].id')
  })

  it('页面引用了不存在的条目 -> E_DANGLING_REF', () => {
    const project = example()
    // p1 已有 3 个条目（r1/g1/u1），追加的是第 4 个。
    project.pages[0]!.entries.push({ id: 'rGhost', order: 9, theme: { kind: 'builtin', value: 'entry-dark' } })
    const issues = validateProject(project).filter((i) => i.code === 'E_DANGLING_REF')
    expect(issues[0]!.where).toBe('pages[0].entries[3].id')
  })
})

describe('表达式目标合法（6.4、5.9 权限矩阵、11.1 第 1/2 条）', () => {
  it('价格表达式用 rand() -> E_RAND_DISABLED（PRD 补充 1）', () => {
    const project = example()
    project.generators[0]!.costs[0]!.amount = '10 * rand()'
    const issues = validateProject(project).filter((i) => i.code === 'E_RAND_DISABLED')
    expect(issues.map((i) => i.where)).toEqual(['generators[0].costs[0].amount'])
  })

  it('同一段文本在不同上下文结论不同：rand() 在产出表达式里合法', () => {
    const project = example()
    project.generators[0]!.produces[0]!.amount = '1 + rand()'
    expect(validateProject(project).filter((i) => i.where === 'generators[0].produces[0].amount')).toEqual([])
  })

  it('写只读属性 -> E_READONLY_TARGET（gen.<id>.perSec / page.<id>.columns）', () => {
    const project = example()
    project.upgrades[0]!.effects[0]!.action = 'gen.g1.perSec = 1'
    expect(validateProject(project).some((i) => i.code === 'E_READONLY_TARGET')).toBe(true)

    const project2 = example()
    project2.upgrades[0]!.effects[0]!.action = 'page.p1.columns = 3'
    const issues = validateProject(project2).filter((i) => i.code === 'E_READONLY_TARGET')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.where).toBe('upgrades[0].effects[0].action')
  })

  it('布尔属性赋字符串 -> E_ASSIGN_TYPE（5.9.3 表）', () => {
    const project = example()
    project.upgrades[0]!.effects[0]!.action = 'gen.g1.visible = "yes"'
    expect(validateProject(project).some((i) => i.code === 'E_ASSIGN_TYPE')).toBe(true)
  })

  it('未知变量/属性按 17.1 报码', () => {
    // 属性**名**不存在：编译期可判定 -> E_UNKNOWN_ATTR（资源无 bought，D-20）。
    const project = example()
    project.generators[0]!.produces[0]!.amount = 'res.r1.bought + 1'
    expect(validateProject(project).some((i) => i.code === 'E_UNKNOWN_ATTR')).toBe(true)
    // 未知标识符 -> E_UNKNOWN_IDENT。
    const project2 = example()
    project2.generators[0]!.produces[0]!.amount = 'whatever + 1'
    expect(validateProject(project2).some((i) => i.code === 'E_UNKNOWN_IDENT')).toBe(true)
  })

  it('引用不存在的条目 id 不是编译期错误（D-08 分层：静态图不含条目表，运行期兜底）', () => {
    const project = example()
    // `res.r99` 的 id 合法（`r` 前缀），但项目里没有这个资源。
    // 静态检查只看属性名，因此不报错；运行期 `AttributeStore` 读不到会抛 `E_UNKNOWN_ATTR`。
    project.generators[0]!.produces[0]!.amount = 'res.r99.amount + 1'
    expect(validateProject(project)).toEqual([])
  })

  it('静态依赖环 -> E_CYCLE 并给出环路径（11.1 第 1 条、D-08）', () => {
    const project = example()
    // 自指：产出速率表达式读了它自己。作者很容易写出这种公式而不自知。
    project.generators[0]!.produces[0]!.amount = 'gen.g1.produces[0].amount + 1'
    const cycles = findStaticCycles(project)
    expect(cycles.length).toBeGreaterThan(0)
    expect(cycles[0]!.code).toBe('E_CYCLE')
    expect(cycles[0]!.message).toContain('->')
    // 同一个环只报一次。
    expect(findStaticCycles(project)).toHaveLength(cycles.length)
  })

  it('双节点环：两个生成器互相读对方的产出速率', () => {
    const project = example()
    project.generators[0]!.produces[0]!.amount = 'gen.g2.produces[0].amount + 1'
    project.generators[1]!.produces[0]!.amount = 'gen.g1.produces[0].amount + 1'
    const cycles = findStaticCycles(project)
    expect(cycles.some((c) => c.code === 'E_CYCLE')).toBe(true)
    expect(cycles[0]!.message).toContain('produces[0].amount')
  })

  it('复合赋值 `+=` 不被误判成自指环（5.2 assignment）', () => {
    const project = example()
    // `x += x` 读旧值再写回，是合法的热替换写法（8.7「按条件切换表达式结构」的反例对照）。
    project.upgrades[0]!.effects[0]!.action = 'gen.g1.max += gen.g1.max'
    expect(findStaticCycles(project).filter((c) => c.code === 'E_CYCLE')).toEqual([])
  })

  it('create() 的 page 不存在 -> E_PAGE_UNKNOWN（11.1 第 5 条）', () => {
    const project = example()
    project.upgrades[0]!.effects.push({
      condition: 'true',
      action: 'create("upgrade", { page: "pNope", costs: [] })',
    })
    const issues = validateProject(project).filter((i) => i.code === 'E_PAGE_UNKNOWN')
    expect(issues).toHaveLength(1)
    expect(issues[0]!.where).toBe('upgrades[0].effects[3].action')
  })

  it('create() 缺 page / 未知键在编译期就被拦下，不进运行期（5.2 约束表）', () => {
    const project = example()
    project.upgrades[0]!.effects.push({ condition: 'true', action: 'create("upgrade", { costs: [] })' })
    expect(validateProject(project).some((i) => i.code === 'E_CREATE_NO_PAGE')).toBe(true)

    const project2 = example()
    project2.upgrades[0]!.effects.push({
      condition: 'true',
      action: 'create("upgrade", { page: "p1", nope: 1 })',
    })
    expect(validateProject(project2).some((i) => i.code === 'E_CREATE_FIELD_INVALID')).toBe(true)
  })

  it('字面量只能出现在 create() 的 spec 内（5.2 约束表、13 第 2 条）', () => {
    const project = example()
    project.upgrades[0]!.conditions[0] = 'true && ({ a: 1 })'
    expect(validateProject(project).some((i) => i.code === 'E_LITERAL_NOT_ALLOWED')).toBe(true)
  })
})

describe('迁移器（6.4）', () => {
  it('V1.0 无迁移步骤：版本即最新，直接放行', () => {
    expect(MIGRATIONS).toEqual({})
    expect(migrateProject(createDefaultProject())).toMatchObject({ version: 1 })
  })

  it('版本高于当前引擎 -> E_VERSION', () => {
    try {
      migrateProject({ ...createDefaultProject(), version: 99 })
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_VERSION')
    }
  })

  it('缺迁移步骤 -> E_MIGRATION_FAIL（兼容模式入口，6.4）', () => {
    try {
      // 人为制造“已知旧版本”，但 MIGRATIONS 为空 -> 没有可用步骤。
      migrateProject({ ...createDefaultProject(), version: 0 })
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_MIGRATION_FAIL')
    }
  })

  it('parseProjectFile 对不一致文件整体拒绝并汇总问题（6.4「阻断保存/打包」）', () => {
    const project = example()
    project.pages[1]!.entries.push({ id: 'r1', order: 2, theme: { kind: 'builtin', value: 'entry-dark' } })
    project.generators[0]!.costs[0]!.materialId = 'rGone'
    try {
      parseProjectFile(project)
      throw new Error('应当抛错')
    } catch (error) {
      const forgeError = error as ForgeError
      expect(forgeError.code).toBe('E_SCHEMA')
      expect(forgeError.message).toContain('E_DUPLICATE_PAGE_ENTRY')
      expect(forgeError.message).toContain('E_DANGLING_REF')
    }
  })
})
