import 'fake-indexeddb/auto'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDefaultProject, createResource, parseProjectFile } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'
import { ForgeError } from '@iforge/num'

import {
  AssetRepository,
  DB_NAME,
  MetaRepository,
  META_KEYS,
  ProjectRepository,
  SaveRepository,
  ValidationBlockedError,
  assertProjectSize,
  deleteForgeDb,
  exportProjectJson,
  importProjectJson,
  loadProjectAssets,
  newAssetId,
  normalizeProjectAssets,
  openForgeDb,
  projectFileName,
  saveKey,
} from '../src/index.js'

/** 每个用例一个独立库名（10.1 的库名参数化就是为测试隔离准备的）。 */
let dbCounter = 0
async function freshDb(): Promise<IDBDatabase> {
  dbCounter += 1
  await deleteForgeDb(`${DB_NAME}-test-${dbCounter}`)
  return openForgeDb(`${DB_NAME}-test-${dbCounter}`)
}

describe('@iforge/persist 项目仓储（TECH_DESIGN 7.9、10.1）', () => {
  let db: IDBDatabase
  let projects: ProjectRepository

  beforeEach(async () => {
    db = await freshDb()
    projects = new ProjectRepository(db)
  })

  it('保存会校验并写入 modifiedAt / engineVersion（PRD 设置页 5）', async () => {
    const project = createDefaultProject({ now: '2026-01-01T00:00:00.000Z' })
    const saved = await projects.save('pid-1', project, { now: '2026-02-02T00:00:00.000Z' })
    expect(saved.meta.modifiedAt).toBe('2026-02-02T00:00:00.000Z')
    expect(saved.meta.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(saved.engineVersion).toBe('1.0.0')
    const record = await projects.list()
    expect(record).toHaveLength(1)
    expect(record[0]?.projectId).toBe('pid-1')
    expect(record[0]?.name).toBe('未命名项目')
  })

  it('校验失败阻断保存并给出可定位的问题清单（6.4、10.2）', async () => {
    const project = createDefaultProject() as ProjectFile
    // 悬空引用：价格材料指向不存在的资源。
    project.generators.push({
      kind: 'generator',
      id: 'g1',
      order: 1,
      name: '坏生成器',
      description: '',
      icon: { kind: 'builtin', value: 'factory' },
      visible: true,
      initial: '0',
      max: 'Infinity',
      disabled: false,
      isClicker: false,
      buyAmount: '1',
      buyDelay: 1,
      costs: [{ materialId: 'rNope', amount: '10' }],
      produces: [],
    })
    await expect(projects.save('pid-1', project)).rejects.toBeInstanceOf(ValidationBlockedError)
    try {
      await projects.save('pid-1', project)
    } catch (error) {
      const issues = (error as ValidationBlockedError).issues
      expect(issues.some((issue) => issue.code === 'E_DANGLING_REF' && issue.where === 'generators[0].costs[0].materialId')).toBe(true)
    }
    // 未通过校验的内容不落库。
    expect(await projects.count()).toBe(0)
  })

  it('静态 id 命名约束在保存时生效（E_ID_INVALID、D-45）', async () => {
    const project = createDefaultProject() as ProjectFile
    project.resources.push({ ...createResource({ id: 'my-resource' }) })
    await expect(projects.save('pid-1', project)).rejects.toBeInstanceOf(ValidationBlockedError)
  })

  it('list 按 modifiedAt 倒序（by-modifiedAt 索引）', async () => {
    await projects.save('a', createDefaultProject(), { now: '2026-01-01T00:00:00.000Z' })
    await projects.save('b', createDefaultProject(), { now: '2026-03-01T00:00:00.000Z' })
    const list = await projects.list()
    expect(list.map((r) => r.projectId)).toEqual(['b', 'a'])
  })

  it('删除项目会一并删除其存档（不留孤儿存档）', async () => {
    await projects.save('a', createDefaultProject())
    const saves = new SaveRepository(db)
    await saves.put({
      format: 'incrementforge-save',
      version: 1,
      engineVersion: '1.0.0',
      projectId: 'a',
      projectName: '未命名项目',
      slotId: 'main',
      savedAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
      playtime: 0,
      gameTime: 0,
      offlineAccum: 0,
      resources: {},
      generators: {},
      upgrades: {},
      pages: {},
      dynamic: { generators: [], upgrades: [] },
    })
    expect(await saves.listByProject('a')).toHaveLength(1)
    await projects.remove('a')
    expect(await projects.get('a')).toBeUndefined()
    expect(await saves.listByProject('a')).toHaveLength(0)
  })
})

describe('@iforge/persist 资产链路（TECH_DESIGN 10.1 表、D-12、13 第 6 条）', () => {
  let db: IDBDatabase
  let assets: AssetRepository

  beforeEach(async () => {
    db = await freshDb()
    assets = new AssetRepository(db)
  })

  it('上传落库以 assetId 引用；保存规范化把它内联成 data: 并只保留被引用的资产', async () => {
    const used = await assets.put({ kind: 'icon', mime: 'image/png', data: 'data:image/png;base64,AAAA', name: 'used.png' })
    const unused = await assets.put({ kind: 'icon', mime: 'image/png', data: 'data:image/png;base64,BBBB', name: 'unused.png' })
    expect(used.assetId).toBe(newAssetId('icon'))
    expect(unused.assetId).toBe('icon-2')

    const project = createDefaultProject() as ProjectFile
    project.resources.push({ ...createResource({ id: 'r2' }), icon: { kind: 'asset', value: used.assetId } })
    const normalized = await normalizeProjectAssets(project, assets)

    expect(normalized.resources[0]!.icon).toEqual({ kind: 'data', value: 'data:image/png;base64,AAAA' })
    // 未被引用的资产不进项目文件，但仍在 store 里（D-12）。
    expect(Object.keys(normalized.assets)).toEqual([used.assetId])
    expect(await assets.get(unused.assetId)).toBeDefined()
  })

  it('缺失资产报 E_ASSET_INVALID，而不是静默变成空引用', async () => {
    const project = createDefaultProject() as ProjectFile
    project.resources.push({ ...createResource({ id: 'r2' }), icon: { kind: 'asset', value: 'icon-9' } })
    await expect(normalizeProjectAssets(project, assets)).rejects.toThrow(ForgeError)
  })

  it('载入项目把 asset 引用换成 data URL；解析不到时保留原引用', async () => {
    const row = await assets.put({ kind: 'theme', mime: 'text/css', data: ':root{--iforge-bg:#123}', name: 't.css' })
    const project = createDefaultProject() as ProjectFile
    project.pages[0]!.theme = { kind: 'asset', value: row.assetId }
    project.pages[0]!.entries.push({ id: 'missing', order: 1, theme: { kind: 'asset', value: 'theme-99' } })
    const loaded = await loadProjectAssets(project, assets)
    expect(loaded.pages[0]!.theme).toEqual({ kind: 'data', value: ':root{--iforge-bg:#123}' })
    expect(loaded.pages[0]!.entries[0]!.theme).toEqual({ kind: 'asset', value: 'theme-99' })
  })

  it('单资产超 64KB 报 E_ASSET_TOO_LARGE（10.1 体积约束）', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(70 * 1024)}`
    await expect(assets.put({ kind: 'icon', mime: 'image/png', data: huge, name: 'big.png' })).rejects.toThrow(ForgeError)
  })

  it('项目文件超 16MB 报 E_ASSET_TOO_LARGE（13 第 6 条）', () => {
    expect(() => assertProjectSize('x'.repeat(17 * 1024 * 1024))).toThrow(ForgeError)
    expect(() => assertProjectSize('{}')).not.toThrow()
  })
})

describe('@iforge/persist 项目导入 / 导出（TECH_DESIGN 10.2）', () => {
  let db: IDBDatabase
  let assets: AssetRepository

  beforeEach(async () => {
    db = await freshDb()
    assets = new AssetRepository(db)
  })

  it('导出 -> 导入往返一致（含资源条目与页面归属）', async () => {
    const project = createDefaultProject() as ProjectFile
    const resource = createResource({ taken: new Set(['r1']) })
    project.resources.push(resource)
    project.pages[0]!.entries.push({ id: resource.id, order: 1, theme: { kind: 'builtin', value: 'entry-dark' } })

    const json = await exportProjectJson(project, assets)
    expect(json).toContain('"format": "incrementforge-project"')
    const parsed = importProjectJson(json)
    expect(parsed.resources).toHaveLength(1)
    expect(parsed.pages[0]!.entries[0]!.id).toBe(resource.id)
    expect(parseProjectFile(json).meta.name).toBe('未命名项目')
  })

  it('导出走校验：非法 id 无法导出（10.2「导出前跑一次校验」）', async () => {
    const projects = new ProjectRepository(db)
    const project = createDefaultProject() as ProjectFile
    project.resources.push({ ...createResource({ id: 'bad-id' }) })
    // 导出走的是“序列化”而不是“保存”，因此非法内容在这里也能被 Zod + 一致性校验拦下。
    await expect(exportProjectJson(project, assets)).rejects.toThrow()
    void projects
  })

  it('导入损坏文件给出明确错误码（E_SCHEMA / 14.2 用例）', () => {
    expect(() => importProjectJson('{ not json')).toThrow()
    expect(() => importProjectJson(JSON.stringify({ format: 'wrong', version: 1 }))).toThrow()
  })

  it('导出文件名清洗非法字符（10.2）', () => {
    const project = createDefaultProject()
    project.meta.name = 'a/b:c*d?e"f<g>h|i'
    expect(projectFileName(project)).toBe('a_b_c_d_e_f_g_h_i.json')
    project.meta.name = '   '
    expect(projectFileName(project)).toBe('project.json')
  })
})

describe('@iforge/persist 存档与偏好（TECH_DESIGN 10.1 表的 saves/meta 行、PRD 补充 8、D-22）', () => {
  let db: IDBDatabase

  beforeEach(async () => {
    db = await freshDb()
  })

  it('存档键是 `${projectId}:${slotId}`，V1.0 固定 main', async () => {
    const saves = new SaveRepository(db)
    const save = {
      format: 'incrementforge-save' as const,
      version: 1,
      engineVersion: '1.0.0',
      projectId: 'p1',
      projectName: 'x',
      slotId: 'main',
      savedAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
      playtime: 12,
      gameTime: 20,
      offlineAccum: 0,
      resources: {},
      generators: {},
      upgrades: {},
      pages: {},
      dynamic: { generators: [], upgrades: [] },
    }
    await saves.put(save)
    expect(saveKey('p1', 'main')).toBe('p1:main')
    expect((await saves.get('p1'))?.playtime).toBe(12)
    expect(await saves.listByProject('p1')).toHaveLength(1)
    await saves.remove('p1')
    expect(await saves.get('p1')).toBeUndefined()
  })

  it('meta 存编辑器偏好（不进项目文件，D-22）', async () => {
    const meta = new MetaRepository(db)
    await meta.set(META_KEYS.theme, 'light')
    await meta.set(META_KEYS.paneWidth, 420)
    expect(await meta.get(META_KEYS.theme)).toBe('light')
    expect(await meta.all()).toEqual({ [META_KEYS.theme]: 'light', [META_KEYS.paneWidth]: 420 })
    await meta.delete(META_KEYS.theme)
    expect(await meta.get(META_KEYS.theme)).toBeUndefined()
  })
})
