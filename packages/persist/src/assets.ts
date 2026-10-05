/**
 * 资产仓储与解析链路（TECH_DESIGN 10.1「资产解析链路」、13 第 4/5 条、11.2、D-12）。
 *
 * | 阶段 | 行为 |
 * | --- | --- |
 * | 上传落库 | 先经 `ui-kit` 的过滤（13 第 4/5 条），再写入 `assets`；项目内一律 `{kind:'asset', value: assetId}`，**不在模型内联 data URL** |
 * | 载入 | 按 `assets` store 把 `kind:'asset'` 解析为内存中的 data URL；`builtin` 不查库 |
 * | 保存/导出规范化 | 把**被引用**的资产内联进 `ProjectFile.assets` 并把引用重写为 `{kind:'data', value}`；未被引用的资产从项目文件剔除（仍留在 store 供复用） |
 * | 打包 | 与导出同一条路径（11.1） |
 * | 体积约束 | 单资产 ≤ 64KB、项目文件 ≤ 16MB |
 */
import { ForgeError } from '@iforge/num'
import { MAX_ASSET_BYTES, MAX_PROJECT_BYTES } from '@iforge/ui-kit'
import type { AssetRecord, IconRef, ProjectFile, ThemeRef } from '@iforge/model'

import { STORE, storeOf, withTransaction } from './db.js'
import type { ProjectRepository } from './projects.js'

/** `assets` 仓库记录（10.1 表：`{ mime, blob, name }`，此处存 data 文本而非 Blob）。 */
export interface AssetRow extends AssetRecord {
  assetId: string
  /** 作者可读名（上传时的文件名），便于资产库 UI 展示。 */
  name: string
}

/**
 * 写入资产的入参。
 *
 * **不复用 `Omit<AssetRow, 'assetId'>`**：`AssetRecord` 来自 `.passthrough()` 的 Zod Schema，
 * 其类型带 `[key: string]: unknown` 索引签名，`Omit` 会把它整体保留下来，
 * 于是 `kind`/`mime`/`data` 全退化成 `unknown`。这里显式声明输入形状。
 */
export interface AssetInput {
  assetId?: string
  kind: AssetRecord['kind']
  mime: string
  data: string
  name: string
}

/** `assets` 仓库。 */
export class AssetRepository {
  constructor(private readonly db: IDBDatabase) {}

  /**
   * 写入资产（已通过过滤的 data 文本）。
   *
   * @throws {ForgeError} `E_ASSET_TOO_LARGE`（单资产 > 64KB）
   */
  async put(row: AssetInput): Promise<AssetRow> {
    // 省略 id 时按 store 里已有的键往后取（上传两个图标不能都拿到 `icon-1`）。
    const existing = row.assetId ? undefined : new Set((await this.list()).map((item) => item.assetId))
    const assetId = row.assetId ?? newAssetId(row.kind, existing)
    const data = row.data
    if (new TextEncoder().encode(data).length > MAX_ASSET_BYTES) {
      throw new ForgeError('E_ASSET_TOO_LARGE', { message: `资产 ${row.name} 超过 ${MAX_ASSET_BYTES} 字节` })
    }
    const record: AssetRow = { assetId, kind: row.kind, mime: row.mime, data, name: row.name }
    await withTransaction(this.db, STORE.assets, 'readwrite', (tx) => storeOf(tx, STORE.assets).put(record))
    return record
  }

  async get(assetId: string): Promise<AssetRow | undefined> {
    return withTransaction<AssetRow | undefined>(this.db, STORE.assets, 'readonly', (tx) => storeOf(tx, STORE.assets).get(assetId))
  }

  async list(): Promise<AssetRow[]> {
    return (
      (await withTransaction<AssetRow[]>(this.db, STORE.assets, 'readonly', (tx) => storeOf(tx, STORE.assets).getAll() as IDBRequest<AssetRow[]>)) ??
      []
    )
  }

  async remove(assetId: string): Promise<void> {
    await withTransaction(this.db, STORE.assets, 'readwrite', (tx) => storeOf(tx, STORE.assets).delete(assetId))
  }

  /**
   * 载入项目时把 `kind:'asset'` 引用解析为 data URL（D-12「载入」阶段）。
   *
   * 解析不到的引用保持 `{kind:'asset'}` 原样（**不静默改写**）：它意味着资产库缺条目，
   * 导出规范化时会被报成问题，而不是变成“看起来正常但内容丢失”的空引用。
   */
  async resolve<T extends IconRef | ThemeRef>(ref: T): Promise<T> {
    if (ref.kind !== 'asset') return ref
    const row = await this.get(ref.value)
    if (!row) return ref
    return { kind: 'data', value: row.data } as T
  }
}

/** 资产 id：`icon-<n>` / `theme-<n>`（与条目 id 空间无关，因此不带 `rgup` 前缀，D-45 只约束条目）。 */
export function newAssetId(kind: AssetRecord['kind'], taken: ReadonlySet<string> = new Set()): string {
  let n = 1
  while (taken.has(`${kind}-${n}`)) n += 1
  return `${kind}-${n}`
}

/** 遍历项目里全部图标/主题引用（保存规范化与体积统计的公共入口）。 */
export function* iterateRefs(
  project: ProjectFile,
): Generator<{ holder: { icon?: IconRef; theme?: ThemeRef } & Record<string, unknown>; key: 'icon' | 'theme' }> {
  for (const resource of project.resources) yield { holder: resource, key: 'icon' }
  for (const generator of project.generators) yield { holder: generator, key: 'icon' }
  for (const upgrade of project.upgrades) yield { holder: upgrade, key: 'icon' }
  for (const page of project.pages) {
    yield { holder: page, key: 'icon' }
    yield { holder: page, key: 'theme' }
    for (const entry of page.entries) yield { holder: entry, key: 'theme' }
  }
}

/**
 * 保存/导出规范化（10.1 表的第三行）。
 *
 * - 被引用的资产内联进 `assets`，引用重写为 `{kind:'data'}`；
 * - 未被引用的资产从项目文件剔除（store 里仍保留）；
 * - 数据 URL 引用**原样保留**（它们已经是自包含的）。
 */
export async function normalizeProjectAssets(project: ProjectFile, assets: AssetRepository): Promise<ProjectFile> {
  const inlined: Record<string, AssetRecord> = {}
  const clone = structuredClone(project) as ProjectFile
  for (const { holder, key } of iterateRefs(clone)) {
    const ref = holder[key]
    if (!ref || typeof ref !== 'object') continue
    if (ref.kind !== 'asset') continue
    const row = await assets.get(ref.value)
    if (!row) {
      throw new ForgeError('E_ASSET_INVALID', { message: `资产库中缺少 ${ref.value}（${key}）` })
    }
    inlined[ref.value] = { kind: row.kind, mime: row.mime, data: row.data }
    holder[key] = { kind: 'data', value: row.data } as IconRef
  }
  clone.assets = inlined
  return clone
}

/** 项目文件整体体积上限（13 第 6 条）。 */
export function assertProjectSize(json: string): void {
  const bytes = new TextEncoder().encode(json).length
  if (bytes > MAX_PROJECT_BYTES) {
    throw new ForgeError('E_ASSET_TOO_LARGE', { message: `项目文件 ${bytes} 字节，超过 ${MAX_PROJECT_BYTES} 上限` })
  }
}

/**
 * 载入项目：解析 + 校验 + 把 `kind:'asset'` 引用换成 data URL（10.2「导入项目」第 2 步 + 10.1「载入」）。
 *
 * @throws {ForgeError} `E_SCHEMA` / `E_DANGLING_REF` 等（由 `parseProjectFile` 抛出）
 */
export async function loadProjectAssets(project: ProjectFile, assets: AssetRepository): Promise<ProjectFile> {
  const clone = structuredClone(project) as ProjectFile
  for (const { holder, key } of iterateRefs(clone)) {
    const ref = holder[key]
    if (!ref || typeof ref !== 'object') continue
    holder[key] = await assets.resolve(ref as IconRef)
  }
  // 文件里自带的 `assets` 与 store 合并：文件优先（单文件产物就是纯靠它）。
  return clone
}

/** 便捷入口：读一次项目记录并解析资产引用。 */
export async function readProjectWithAssets(
  projects: ProjectRepository,
  assets: AssetRepository,
  projectId: string,
): Promise<ProjectFile | undefined> {
  const project = await projects.get(projectId)
  return project ? loadProjectAssets(project, assets) : undefined
}
