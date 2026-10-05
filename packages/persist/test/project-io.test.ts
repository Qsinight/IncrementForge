/**
 * 项目导入/导出的**文本层**与结构化问题清单（TECH_DESIGN 10.2、13 第 6 条、6.4「定位路径」）。
 *
 * 这些函数是编辑器与 CLI 共用的最后一道关口：
 * - `exportProjectJson` 先校验再内联资产再序列化（顺序反了会白白拷贝一次大文件）；
 * - `importProjectJson` 的**大小上限先于解析**（超大文件不该拖垮主线程）；
 * - `validation.ts` 负责把 Zod issue 还原成带 `where` 的结构化清单，
 *   编辑器靠 `where` 把红框标到具体输入框——所以“错误码能从 message 里还原出来”是硬要求。
 */
import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDefaultProject, createExampleProject, parseProjectFile, PROJECT_FORMAT, ENGINE_VERSION } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'
import { ForgeError, Num } from '@iforge/num'

import {
  AssetRepository,
  DB_NAME,
  ProjectRepository,
  deleteForgeDb,
  exportProjectJson,
  formatIssues,
  importProjectJson,
  openForgeDb,
  prepareForSave,
  projectFileName,
  throwIssues,
  ValidationBlockedError,
} from '../src/index.js'
import { formatWhere, issueFromError, issueFromZod, issuesFromZod } from '../src/validation.js'
import { readProjectWithAssets } from '../src/assets.js'

let dbCounter = 0
async function freshRepos(): Promise<{ projects: ProjectRepository; assets: AssetRepository }> {
  dbCounter += 1
  const name = `${DB_NAME}-pio-${dbCounter}`
  await deleteForgeDb(name)
  const db = await openForgeDb(name)
  return { projects: new ProjectRepository(db), assets: new AssetRepository(db) }
}

describe('projectFileName()：导出建议文件名（10.2）', () => {
  it('用项目名 + `.json`', () => {
    const p = createDefaultProject()
    p.meta.name = '我的游戏'
    expect(projectFileName(p)).toBe('我的游戏.json')
  })

  it('非法文件名字符替换为 `_`（Windows/POSIX 都要挡住）', () => {
    const p = createDefaultProject()
    p.meta.name = 'a/b:c*d?e"f<g>h|i'
    expect(projectFileName(p)).toBe('a_b_c_d_e_f_g_h_i.json')
  })

  it('空名/纯空白回落到 `project.json`', () => {
    const p = createDefaultProject()
    p.meta.name = ''
    expect(projectFileName(p)).toBe('project.json')
    p.meta.name = '   '
    expect(projectFileName(p)).toBe('project.json')
  })
})

describe('exportProjectJson()：先校验、再内联、最后序列化', () => {
  let projects: ProjectRepository
  let assets: AssetRepository

  beforeEach(async () => {
    const repos = await freshRepos()
    projects = repos.projects
    assets = repos.assets
  })

  it('导出格式化 JSON，能被 `parseProjectFile` 原样解析回来', async () => {
    const project = createExampleProject()
    const json = await exportProjectJson(project, assets)
    // 格式化而不是 minified（10.2「序列化为格式化 JSON」）。
    expect(json.split('\n').length).toBeGreaterThan(50)
    const back = parseProjectFile(json)
    expect(back.format).toBe(PROJECT_FORMAT)
    expect(back.resources.length).toBe(project.resources.length)
    expect(back.generators.length).toBe(project.generators.length)
  })

  it('导出**前**校验不通过就抛错，不产出文件内容（10.2「列出问题位置」）', async () => {
    const project = createExampleProject()
    project.generators[0]!.costs[0]!.materialId = 'rNope'
    // `validateOrThrow` 抛的是 `ValidationBlockedError`（带结构化 `issues`），
    // 不是 `ForgeError`——编辑器要靠 `issues[].where` 标红框，所以必须是结构化的。
    await expect(exportProjectJson(project, assets)).rejects.toBeInstanceOf(ValidationBlockedError)
  })

  it('资产引用被内联成 `data:`（10.2「资产内联为 data:」）', async () => {
    const project = createDefaultProject()
    const asset = await assets.put({
      kind: 'icon',
      mime: 'image/png',
      data: 'data:image/png;base64,iVBORw0KGgo=',
      name: 'icon-x.png',
    })
    project.resources = [
      {
        kind: 'resource',
        id: 'r1',
        order: 1,
        name: '资源',
        description: '',
        icon: { kind: 'asset', value: asset.assetId },
        initial: '0',
        max: 'Infinity',
        visible: true,
      },
    ]
    project.pages[0]!.entries = [{ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }]
    const json = await exportProjectJson(project, assets)
    // 内联后**引用点**变成 data URL：`assets` 仓库里的条目仍随文件带出（合并而非删除），
    // 所以断言要看引用点解析后的形态，而不是“文件里没有这个 id”。
    const back = parseProjectFile(json)
    expect(back.resources[0]!.icon).toEqual({ kind: 'data', value: 'data:image/png;base64,iVBORw0KGgo=' })
  })

  it('`exportProjectJson` 不改动传入的项目对象（纯函数语义）', async () => {
    const project = createExampleProject()
    const before = JSON.stringify(project)
    await exportProjectJson(project, assets)
    expect(JSON.stringify(project)).toBe(before)
  })

  it('不相关的 `projects` 仓储不参与导出（导出只读资产）', async () => {
    const project = createExampleProject()
    expect(await exportProjectJson(project, assets)).toContain(PROJECT_FORMAT)
    void projects
  })
})

describe('importProjectJson()：大小上限先于解析（13 第 6 条）', () => {
  it('合法文本可解析', () => {
    const project = importProjectJson(JSON.stringify(createExampleProject()))
    expect(project.format).toBe(PROJECT_FORMAT)
  })

  it('超上限抛 `E_ASSET_TOO_LARGE` 且**不**进解析', () => {
    // 构造一个远超 16MB 的文本：若解析先跑，Zod 会先报结构问题；
    // 断言拿到的是体积错误码，才能证明“先判大小”这条顺序。
    const huge = `{"format":"${PROJECT_FORMAT}","padding":"${'x'.repeat(17 * 1024 * 1024)}"}`
    expect(() => importProjectJson(huge)).toThrow(ForgeError)
    try {
      importProjectJson(huge)
    } catch (error) {
      expect((error as ForgeError).code).toBe('E_ASSET_TOO_LARGE')
    }
  })

  it('结构不合法抛 `E_SCHEMA`（问题已汇总进 message）', () => {
    expect(() => importProjectJson('{"format":"' + PROJECT_FORMAT + '"}')).toThrow(ForgeError)
  })

  it('非法 JSON 抛错（不静默返回空项目）', () => {
    expect(() => importProjectJson('{ oops')).toThrow(ForgeError)
  })

  it('空文本抛错', () => {
    expect(() => importProjectJson('')).toThrow(ForgeError)
  })
})

describe('prepareForSave()：7.9 的保存时写入两项', () => {
  it('写入 `engineVersion` 与 `meta.modifiedAt`', () => {
    const project = createDefaultProject()
    const saved = prepareForSave(project, '2026-03-04T05:06:07.000Z')
    expect(saved.engineVersion).toBe(ENGINE_VERSION)
    expect(saved.meta.modifiedAt).toBe('2026-03-04T05:06:07.000Z')
  })

  it('不改 `createdAt` 与其它 meta 字段', () => {
    const project = createDefaultProject()
    project.meta.name = '名字'
    project.meta.author = '作者'
    project.meta.createdAt = '2020-01-01T00:00:00.000Z'
    const saved = prepareForSave(project, '2026-03-04T05:06:07.000Z')
    expect(saved.meta.createdAt).toBe('2020-01-01T00:00:00.000Z')
    expect(saved.meta.name).toBe('名字')
    expect(saved.meta.author).toBe('作者')
  })

  it('与 `write-example.ts` 的同名规则等价（11.1 的产物元信息读这两项）', () => {
    const a = prepareForSave(createDefaultProject(), '2026-01-01T00:00:00.000Z')
    const b = createDefaultProject()
    expect(a.engineVersion).toBe(b.engineVersion)
    expect(a.meta.modifiedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('formatIssues() / throwIssues()：问题清单的可展示形态（6.4）', () => {
  it('格式化为 `code @ where — message`', () => {
    const lines = formatIssues([
      { code: 'E_PARSE', where: 'generators[0].costs[0].amount', message: '语法错误' },
      { code: 'E_SCHEMA', where: '', message: '根级问题' },
    ])
    expect(lines[0]).toBe('E_PARSE @ generators[0].costs[0].amount — 语法错误')
    expect(lines[1]).toBe('E_SCHEMA @  — 根级问题')
  })

  it('空 message 时不追加破折号', () => {
    expect(formatIssues([{ code: 'E_ID_INVALID', where: 'resources[0].id', message: '' }])[0]).toBe('E_ID_INVALID @ resources[0].id')
  })

  it('空清单返回空数组', () => {
    expect(formatIssues([])).toEqual([])
  })

  it('`throwIssues` 抛 `E_SCHEMA`，message 含全部问题（10.2「列出问题位置」）', () => {
    expect(() =>
      throwIssues([
        { code: 'E_PARSE', where: 'a', message: 'x' },
        { code: 'E_ID_INVALID', where: 'b', message: 'y' },
      ]),
    ).toThrow(ForgeError)
    try {
      throwIssues([
        { code: 'E_PARSE', where: 'a', message: 'x' },
        { code: 'E_ID_INVALID', where: 'b', message: 'y' },
      ])
    } catch (error) {
      const e = error as ForgeError
      expect(e.code).toBe('E_SCHEMA')
      expect(e.message).toContain('E_PARSE @ a')
      expect(e.message).toContain('E_ID_INVALID @ b')
    }
  })
})

describe('formatWhere()：Zod path -> 定位文本（6.4）', () => {
  it('数组下标用 `[n]`、字段名用 `.`', () => {
    expect(formatWhere(['generators', 0, 'costs', 2, 'amount'])).toBe('generators[0].costs[2].amount')
  })

  it('纯数组根路径', () => {
    expect(formatWhere([0, 'id'])).toBe('[0].id')
  })

  it('空路径返回空串（根级问题）', () => {
    expect(formatWhere([])).toBe('')
  })

  it('单段路径不带前导点', () => {
    expect(formatWhere(['settings', 'tickRate'])).toBe('settings.tickRate')
  })
})

describe('issueFromZod()：从 message 还原错误码（编辑器要按码分支）', () => {
  it('还原 `CODE: message` 形态', () => {
    const issue = issueFromZod({
      code: 'custom',
      path: ['generators', 0, 'costs', 0, 'materialId'],
      message: 'E_DANGLING_REF: 购买材料 "rNope" 不是已存在的资源',
    } as never)
    expect(issue.code).toBe('E_DANGLING_REF')
    expect(issue.where).toBe('generators[0].costs[0].materialId')
    expect(issue.message).toBe('购买材料 "rNope" 不是已存在的资源')
  })

  it('还原纯 `CODE` 形态（message 为空串）', () => {
    const issue = issueFromZod({ code: 'custom', path: ['resources', 0, 'id'], message: 'E_ID_INVALID' } as never)
    expect(issue.code).toBe('E_ID_INVALID')
    expect(issue.where).toBe('resources[0].id')
    expect(issue.message).toBe('')
  })

  it('不匹配错误码形态时回落 `E_SCHEMA` 并保留原 message', () => {
    const issue = issueFromZod({ code: 'invalid_type', path: ['format'], message: 'Required' } as never)
    expect(issue.code).toBe('E_SCHEMA')
    expect(issue.message).toBe('Required')
  })

  it('`issuesFromZod` 批量转换', () => {
    const issues = issuesFromZod([
      { code: 'custom', path: ['a'], message: 'E_PARSE: x' },
      { code: 'custom', path: ['b', 0], message: 'E_ID_INVALID' },
    ] as never)
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.code)).toEqual(['E_PARSE', 'E_ID_INVALID'])
    expect(issues[1]!.where).toBe('b[0]')
  })
})

describe('issueFromError()：结构校验**之前**抛出的错误（版本/迁移）', () => {
  it('`ForgeError` 保留错误码、`where` 与 message', () => {
    const issue = issueFromError(new ForgeError('E_MIGRATION_FAIL', { where: 'version', message: '迁移失败' }))
    expect(issue.code).toBe('E_MIGRATION_FAIL')
    expect(issue.where).toBe('version')
    // `ForgeError.message` 会带上错误码前缀（"文件迁移失败：..."），断言用包含而非全等。
    expect(issue.message).toContain('迁移失败')
  })

  it('`ForgeError` 无 `where` 时留空串（编辑器据此不标红框）', () => {
    const issue = issueFromError(new ForgeError('E_SCHEMA', { message: '结构不对' }))
    expect(issue.where).toBe('')
  })

  it('普通 `Error` 回落 `E_SCHEMA` 并保留 message', () => {
    const issue = issueFromError(new Error('boom'))
    expect(issue.code).toBe('E_SCHEMA')
    expect(issue.message).toBe('boom')
  })

  it('非 Error 值也能字符串化（不抛二次异常）', () => {
    const issue = issueFromError('字符串错误')
    expect(issue.code).toBe('E_SCHEMA')
    expect(issue.message).toBe('字符串错误')
  })
})

describe('readProjectWithAssets()：便捷入口解析资产引用', () => {
  it('项目存在时返回解析后的项目', async () => {
    const { projects, assets } = await freshRepos()
    await projects.save('proj-1', createDefaultProject(), { now: '2026-01-01T00:00:00.000Z' })
    const stored = await projects.get('proj-1')
    expect(stored).toBeDefined()
    const loaded = await readProjectWithAssets(projects, assets, 'proj-1')
    expect(loaded).toBeDefined()
    expect(loaded!.format).toBe(PROJECT_FORMAT)
  })

  it('项目不存在时返回 `undefined`（不抛错）', async () => {
    const { projects, assets } = await freshRepos()
    expect(await readProjectWithAssets(projects, assets, 'missing-id')).toBeUndefined()
  })

  it('内置引用不依赖资产仓库即可解析（单文件产物就是纯靠它）', async () => {
    const { projects, assets } = await freshRepos()
    await projects.save('proj-builtin', createExampleProject(), { now: '2026-01-01T00:00:00.000Z' })
    const loaded = await readProjectWithAssets(projects, assets, 'proj-builtin')
    expect(loaded!.resources[0]!.icon.kind).toBe('builtin')
  })

  it('`kind:asset` 引用被解析为 data URL（13 第 5 条的载入侧）', async () => {
    const { projects, assets } = await freshRepos()
    const asset = await assets.put({
      kind: 'icon',
      mime: 'image/png',
      data: 'data:image/png;base64,iVBORw0KGgo=',
      name: 'icon-y.png',
    })
    const project = createDefaultProject()
    project.resources = [
      {
        kind: 'resource',
        id: 'r1',
        order: 1,
        name: '资源',
        description: '',
        icon: { kind: 'asset', value: asset.assetId },
        initial: '0',
        max: 'Infinity',
        visible: true,
      },
    ]
    project.pages[0]!.entries = [{ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }]
    await projects.save('proj-asset', project, { now: '2026-01-01T00:00:00.000Z' })
    const loaded = await readProjectWithAssets(projects, assets, 'proj-asset')
    expect(loaded!.resources[0]!.icon.kind).toBe('data')
  })

  it('解析不到的资产引用保持 `{kind:asset}` 原样（**不静默改写**）', async () => {
    const { projects, assets } = await freshRepos()
    const project = createDefaultProject()
    project.resources = [
      {
        kind: 'resource',
        id: 'r1',
        order: 1,
        name: '资源',
        description: '',
        icon: { kind: 'asset', value: 'icon-missing' },
        initial: '0',
        max: 'Infinity',
        visible: true,
      },
    ]
    project.pages[0]!.entries = [{ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }]
    await projects.save('proj-missing-asset', project, { now: '2026-01-01T00:00:00.000Z' })
    const loaded = await readProjectWithAssets(projects, assets, 'proj-missing-asset')
    expect(loaded!.resources[0]!.icon).toEqual({ kind: 'asset', value: 'icon-missing' })
  })
})

describe('导出/导入往返（10.2）', () => {
  it('导出的 JSON 再导入后字段逐字一致', async () => {
    const { assets } = await freshRepos()
    const project = createExampleProject()
    const json = await exportProjectJson(project, assets)
    const back = importProjectJson(json)
    expect(back.resources).toEqual(project.resources)
    expect(back.generators).toEqual(project.generators)
    expect(back.upgrades).toEqual(project.upgrades)
    expect(back.pages).toEqual(project.pages)
    expect(back.settings).toEqual(project.settings)
  })

  it('大数文本往返不丢精度（`1e1e10` 这类分层写法必须原样保留）', async () => {
    const { assets } = await freshRepos()
    const project = createDefaultProject()
    project.resources = [
      {
        kind: 'resource',
        id: 'r1',
        order: 1,
        name: '大数',
        description: '',
        icon: { kind: 'builtin', value: 'gem' },
        initial: '0',
        max: '1e1e10',
        visible: true,
      },
    ]
    project.pages[0]!.entries = [{ id: 'r1', order: 1, theme: { kind: 'builtin', value: 'entry-dark' } }]
    const json = await exportProjectJson(project, assets)
    const back = importProjectJson(json)
    // 文本**不**被求值成 JS number 再写回。
    expect(back.resources[0]!.max).toBe('1e1e10')
    expect(Num.fromString(back.resources[0]!.max).gte(Num.fromString('1e1e10'))).toBe(true)
  })

  it('往返不改变 `ProjectFile` 的类结构（普通对象即可）', async () => {
    const { assets } = await freshRepos()
    const json = await exportProjectJson(createDefaultProject(), assets)
    const back = importProjectJson(json) as ProjectFile
    expect(Object.keys(back).sort()).toEqual(Object.keys(createDefaultProject()).sort())
  })
})
