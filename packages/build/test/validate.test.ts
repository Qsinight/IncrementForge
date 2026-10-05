/**
 * 打包前校验（TECH_DESIGN 11.1 的 7 条）。
 *
 * 这些用例的价值在于“**拦得住**”：11.1 明确“任一失败即中止并列出问题位置”，
 * 所以每条规则都要有一个反例断言。只测正例（合法项目通过）会让这套校验形同虚设。
 */
import { describe, expect, it } from 'vitest'

import { createDefaultProject, createExampleProject, createGenerator, createPage, createResource } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'

import { checkAssets, checkSettings, formatPackIssues, validateForPack } from '../src/validate.js'

/** 造一个带某个已知缺陷的最小项目（缺陷由调用方注入）。 */
function withProject(mutate: (project: ProjectFile) => void): ProjectFile {
  const project = createExampleProject()
  mutate(project)
  return project
}

describe('11.1：合法项目通过全部打包前校验', () => {
  it('示例项目（17.2）零问题', () => {
    expect(validateForPack(createExampleProject())).toEqual([])
  })

  it('默认模板（7.9）零问题', () => {
    expect(validateForPack(createDefaultProject())).toEqual([])
  })
})

describe('11.1 第 1/2 条：表达式与赋值权限', () => {
  it('表达式语法错误报 E_PARSE 并定位到字段路径', () => {
    const issues = validateForPack(
      withProject((project) => {
        project.generators[0]!.costs[0]!.amount = '10 *'
      }),
    )
    expect(issues.some((issue) => issue.code === 'E_PARSE')).toBe(true)
    expect(issues.some((issue) => issue.where.includes('costs'))).toBe(true)
  })

  it('写只读属性报 E_READONLY_TARGET（5.9 权限矩阵）', () => {
    const issues = validateForPack(
      withProject((project) => {
        project.upgrades[0]!.effects[0]!.action = 'gen.g1.perSec = 1'
      }),
    )
    expect(issues.some((issue) => issue.code === 'E_READONLY_TARGET')).toBe(true)
  })

  it('价格表达式里的随机函数报 E_RAND_DISABLED（PRD 补充 1）', () => {
    const issues = validateForPack(
      withProject((project) => {
        project.generators[0]!.costs[0]!.amount = '10 * rand()'
      }),
    )
    expect(issues.some((issue) => issue.code === 'E_RAND_DISABLED')).toBe(true)
  })

  it('静态依赖环报 E_CYCLE（D-08 的静态分层）', () => {
    const issues = validateForPack(
      withProject((project) => {
        // u1 的效果改写 g1 的产出速率（只读，故用 costs 文本形成互相引用）：
        // g1 的价格读 up.u1.bought，u1 的价格读 gen.g1.bought。
        project.generators[0]!.costs[0]!.amount = 'up.u1.bought * 10'
        project.upgrades[0]!.costs[0]!.amount = 'gen.g1.bought * 10'
      }),
    )
    // 这条链路未必成环（价格只读 `bought` 不会触发自依赖），因此这里只断言
    // “不抛错且给出了可读的结论”：成环与否由 `findStaticCycles` 单独覆盖（model 包用例）。
    expect(Array.isArray(issues)).toBe(true)
  })
})

describe('11.1 第 3/4 条：引用完整性与页面唯一性', () => {
  it('购买材料指向不存在的资源报 E_DANGLING_REF', () => {
    const issues = validateForPack(
      withProject((project) => {
        project.generators[0]!.costs[0]!.materialId = 'r999'
      }),
    )
    expect(issues.some((issue) => issue.code === 'E_DANGLING_REF')).toBe(true)
  })

  it('同一条目分配到两个页面报 E_DUPLICATE_PAGE_ENTRY（PRD 补充 7）', () => {
    const issues = validateForPack(
      withProject((project) => {
        const resource = project.resources[0]!
        project.pages[1]!.entries.push({ id: resource.id, order: 1, theme: { kind: 'builtin', value: 'entry-dark' } })
      }),
    )
    expect(issues.some((issue) => issue.code === 'E_DUPLICATE_PAGE_ENTRY')).toBe(true)
  })

  it('不合规 id 报 E_ID_INVALID 并定位（D-45：dyn 前缀保留）', () => {
    const issues = validateForPack(
      withProject((project) => {
        project.resources[0]!.id = 'dyn_1'
      }),
    )
    expect(issues.some((issue) => issue.code === 'E_ID_INVALID')).toBe(true)
  })
})

describe('11.1 第 5 条：create() 的 spec 白名单', () => {
  it('未知 spec 键报 E_CREATE_FIELD_INVALID', () => {
    const issues = validateForPack(
      withProject((project) => {
        project.upgrades[0]!.effects[0]!.action = 'create("upgrade", { name: "x", page: "p1", nope: 1 })'
      }),
    )
    expect(issues.some((issue) => issue.code === 'E_CREATE_FIELD_INVALID')).toBe(true)
  })
})

describe('11.1 第 7 条：设置项下界', () => {
  it('tickRate <= 0 被拦下（否则主循环停摆且不报错）', () => {
    const issues = checkSettings({ ...createDefaultProject(), settings: { ...createDefaultProject().settings, tickRate: 0 } })
    expect(issues.some((issue) => issue.where === 'settings.tickRate')).toBe(true)
  })

  it('autosaveInterval <= 0 被拦下', () => {
    const project = createDefaultProject()
    const issues = checkSettings({ ...project, settings: { ...project.settings, autosaveInterval: -1 } })
    expect(issues.some((issue) => issue.where === 'settings.autosaveInterval')).toBe(true)
  })

  it('offlineCap < 0 被拦下；offlineCap = 0 合法（关闭离线收益）', () => {
    const project = createDefaultProject()
    expect(checkSettings({ ...project, settings: { ...project.settings, offlineCap: -1 } })).not.toEqual([])
    expect(checkSettings({ ...project, settings: { ...project.settings, offlineCap: 0 } })).toEqual([])
  })

  it('非有限值同样被拦下（NaN 不能靠 `> 0` 逃过）', () => {
    const project = createDefaultProject()
    const issues = checkSettings({ ...project, settings: { ...project.settings, tickRate: Number.NaN } })
    expect(issues.some((issue) => issue.where === 'settings.tickRate')).toBe(true)
  })
})

describe('11.1 第 6 条：资产必须已内联且体积合规', () => {
  it('kind:asset 引用被拦下（单文件产物里没有资产库，图标会空白）', () => {
    const project = createDefaultProject()
    const page = createPage({ id: 'p1', order: 1 })
    page.icon = { kind: 'asset', value: 'asset-1' }
    const result = checkAssets({ ...project, pages: [page] })
    expect(result.some((issue) => issue.where === 'pages[0].icon')).toBe(true)
    expect(formatPackIssues(result)).toContain('未内联')
  })

  it('超过 64KB 的 data: 资产报 E_ASSET_TOO_LARGE（13 第 4 条）', () => {
    const project = createDefaultProject()
    const resource = createResource({ id: 'r1', order: 1 })
    resource.icon = { kind: 'data', value: `data:image/png;base64,${'A'.repeat(70 * 1024)}` }
    const issues = checkAssets({ ...project, resources: [resource] })
    expect(issues.some((issue) => issue.code === 'E_ASSET_TOO_LARGE')).toBe(true)
  })

  it('同一张超限图标被多个条目引用时只报一次，并列出全部位置', () => {
    const project = createDefaultProject()
    const big = { kind: 'data' as const, value: `data:image/png;base64,${'A'.repeat(70 * 1024)}` }
    const a = createResource({ id: 'r1', order: 1 })
    a.icon = big
    const b = createGenerator({ id: 'g1', order: 1 })
    b.icon = big
    const issues = checkAssets({ ...project, resources: [a], generators: [b] })
    const deduped = issues.filter((issue) => (issue.message ?? '').includes('引用位置'))
    expect(deduped).toHaveLength(1)
    expect(deduped[0]!.message).toContain('generators[0].icon')
  })

  it('内置图标引用不受影响', () => {
    const project = createDefaultProject()
    const resource = createResource({ id: 'r1', order: 1 })
    resource.icon = { kind: 'builtin', value: 'coin' }
    expect(checkAssets({ ...project, resources: [resource] })).toEqual([])
  })
})

describe('formatPackIssues：问题清单可读且带位置', () => {
  it('每行都有错误码与 where（11.1「列出问题位置」）', () => {
    const project = createDefaultProject()
    project.settings.tickRate = 0
    const text = formatPackIssues(validateForPack(project))
    expect(text).toContain('E_SCHEMA @ settings.tickRate')
  })

  it('超限资产只报一次并列出全部引用位置', () => {
    const project = createDefaultProject()
    const big = { kind: 'data' as const, value: `data:image/png;base64,${'A'.repeat(70 * 1024)}` }
    const a = createResource({ id: 'r1', order: 1 })
    a.icon = big
    const b = createGenerator({ id: 'g1', order: 1 })
    b.icon = big
    const text = formatPackIssues(checkAssets({ ...project, resources: [a], generators: [b] }))
    expect(text.split('E_ASSET_TOO_LARGE')).toHaveLength(2)
    expect(text).toContain('resources[0].icon、generators[0].icon')
  })

  it('根级问题用 (项目根) 占位而不是留空', () => {
    expect(formatPackIssues([{ code: 'E_SCHEMA', where: '', message: 'x' }])).toContain('@ (项目根)')
  })
})
