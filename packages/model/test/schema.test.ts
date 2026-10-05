/**
 * 项目文件 Schema 的结构校验（6.2、6.4）。
 */
import { describe, expect, it } from 'vitest'

import { ForgeError, resetDiagnostics } from '@iforge/num'
import { CREATE_SPEC_FIELD_LIST } from '@iforge/expr'
import {
  DEFAULT_SETTINGS,
  ENGINE_VERSION,
  SAVE_TOP_LEVEL_FIELDS,
  checkCreateSpecCoverage,
  checkSaveCoverage,
  createDefaultProject,
  createExampleProject,
  createGenerator,
  createPage,
  createResource,
  createUpgrade,
  parseProjectFile,
  projectFileSchema,
  saveFileSchema,
  validateProject,
} from '../src/index.js'

const NOW = '2026-01-01T00:00:00.000Z'

function baseProject() {
  return createDefaultProject({ now: NOW, engineVersion: ENGINE_VERSION })
}

describe('项目文件 Schema（6.2）', () => {
  it('新建项目模板符合 6.2/7.9：默认页面 p1、条目列表为空、settings 取默认值', () => {
    const project = baseProject()
    expect(project.format).toBe('incrementforge-project')
    expect(project.version).toBe(1)
    expect(project.meta).toEqual({ name: '未命名项目', author: '', description: '', createdAt: NOW, modifiedAt: NOW })
    expect(project.settings).toEqual(DEFAULT_SETTINGS)
    expect(project.resources).toEqual([])
    expect(project.generators).toEqual([])
    expect(project.upgrades).toEqual([])
    expect(project.assets).toEqual({})
    expect(project.pages).toHaveLength(1)
    expect(project.pages[0]).toMatchObject({
      id: 'p1',
      name: '主页面',
      visible: true,
      disabled: false,
      columns: 1,
      entries: [],
    })
    // 游戏内“设置”页是运行时内置页，不属于 pages（7.9）。
    expect(project.pages.map((page) => page.id)).not.toContain('__settings__')
  })

  it('新建条目落默认字段：NumExpr 一律字符串、max 默认 Infinity、买量默认 "1"', () => {
    const resource = createResource({ taken: new Set() })
    expect(resource.initial).toBe('0')
    expect(resource.max).toBe('Infinity')
    expect(resource.kind).toBe('resource')

    const generator = createGenerator({ taken: new Set(['g1']) })
    expect(generator.id).toBe('g2')
    expect(generator.buyAmount).toBe('1')
    expect(generator.buyDelay).toBe(1)
    expect(generator.isClicker).toBe(false)
    expect(generator.costs).toEqual([])

    const upgrade = createUpgrade({ taken: new Set() })
    expect(upgrade.conditions).toEqual([])
    expect(upgrade.effects).toEqual([])
    expect(upgrade.perSecond).toBe(false)

    // 页面复制不复制 entries（D-39、PRD 补充 7）。
    expect(createPage({ taken: new Set() }).entries).toEqual([])
  })

  it('结构错误报 E_SCHEMA 并定位路径（6.4「非法字段报错并定位路径」）', () => {
    const project = baseProject()
    project.settings.tickRate = 0 // 打包前校验要求 tickRate > 0（11.1 第 7 条）
    const result = projectFileSchema.safeParse(project)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'settings.tickRate')).toBe(true)
    }
  })

  it('拒绝 __proto__ 键（13 第 6 条）', () => {
    const raw = JSON.parse(
      '{"format":"incrementforge-project","version":1,"engineVersion":"1.0.0",' +
        '"meta":{"name":"x","author":"","description":"","createdAt":"2026-01-01T00:00:00.000Z","modifiedAt":"2026-01-01T00:00:00.000Z"},' +
        '"settings":{"numberFormat":"standard","tickRate":20,"maxFrameStep":250,"autosaveInterval":30,"offlineEnabled":true,"offlineCap":8},' +
        '"resources":[],"generators":[],"upgrades":[],"pages":[],"assets":{},"__proto__":{"polluted":true}}',
    )
    const result = projectFileSchema.safeParse(raw)
    expect(result.success).toBe(false)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('未知字段保留（向前兼容，6.4 末条），而不是被 strict 模式拒绝', () => {
    const project = baseProject()
    const raw = { ...project, futureField: { x: 1 } }
    const result = projectFileSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>)['futureField']).toEqual({ x: 1 })
    }
  })
})

describe('存档 Schema（6.3）', () => {
  it('完整不变式：四类实体都带 assignments，升级带 effectValues', () => {
    const save = {
      format: 'incrementforge-save' as const,
      version: 1,
      engineVersion: '1.0.0',
      projectId: 'p',
      projectName: 'x',
      slotId: 'main',
      savedAt: NOW,
      lastSeenAt: NOW,
      playtime: 0,
      gameTime: 0,
      offlineAccum: 0,
      resources: {
        r1: { amount: '0', max: 'Infinity', initial: '0', visible: true, description: '', assignments: {} },
      },
      generators: {
        g1: {
          bought: '0',
          owned: '0',
          max: 'Infinity',
          initial: '0',
          visible: true,
          disabled: false,
          isClicker: false,
          buyAmount: '1',
          buyDelay: 1,
          description: '',
          assignments: {},
        },
      },
      upgrades: {
        u1: {
          bought: '0',
          owned: '0',
          max: 'Infinity',
          initial: '0',
          visible: true,
          disabled: false,
          buyAmount: '1',
          buyDelay: 1,
          perSecond: false,
          description: '',
          effectValues: {},
          assignments: {},
        },
      },
      pages: { p1: { visible: true, disabled: false, description: '', assignments: {} } },
      dynamic: { generators: [], upgrades: [] },
    }
    const result = saveFileSchema.safeParse(save)
    expect(result.success).toBe(true)
  })

  it('存档不含 currentPageId：导航状态不持久化（D-50、14.3 规则 5）', () => {
    expect(validateProject(createExampleProject())).toEqual([])
    // `currentPageId` 不是存档字段、也不是表达式属性（6.3 / 5.9 均无落点）。
    expect(SAVE_TOP_LEVEL_FIELDS).not.toHaveProperty('currentPageId')
    for (const shape of Object.values(SAVE_TOP_LEVEL_FIELDS)) {
      expect(Object.keys(shape)).not.toContain('currentPageId')
    }
  })
})

describe('权限矩阵 ↔ 存档 Schema 自检（14.3 规则 1、R-33）', () => {
  it('5.9 中「可写且存档位置含顶层」的属性全部出现在 6.3 的顶层字段里', () => {
    expect(checkSaveCoverage()).toEqual([])
  })

  it('create() 的 spec 字段是 GeneratorDef/UpgradeDef 的子集（5.2 约束表、8.7）', () => {
    expect(checkCreateSpecCoverage(CREATE_SPEC_FIELD_LIST)).toEqual([])
  })
})

describe('parseProjectFile（10.2「导入项目」）', () => {
  it('接受示例项目并原样返回（17.2）', () => {
    const project = parseProjectFile(createExampleProject())
    expect(project.meta.name).toBe('示例：矿石工厂')
    expect(project.generators[0]?.costs[0]?.amount).toBe('10 * 1.15 ^ gen.g1.bought')
  })

  it('format 不符报 E_VERSION（6.4「兼容模式」）', () => {
    const project = { ...baseProject(), format: 'something-else' }
    expect(() => parseProjectFile(project)).toThrow(ForgeError)
    try {
      parseProjectFile(project)
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_VERSION')
    }
  })

  it('损坏文件给出明确错误路径（14.2「导入旧版本项目文件」）', () => {
    try {
      parseProjectFile('not json at all')
      throw new Error('不应该抛错')
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_SCHEMA')
    }
    resetDiagnostics()
  })
})
