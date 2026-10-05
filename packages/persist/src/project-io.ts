/**
 * 项目导入 / 导出（TECH_DESIGN 10.2、11.1「打包前校验」的共享路径、13 第 6 条）。
 *
 * ## 与打包同一条序列化路径
 *
 * 10.1 末条：「打包与『导出存档』走同一条序列化路径，保证编辑器与游戏一致」。
 * 因此本模块只提供“项目文件 <-> 文本”的双向函数，`build` 包（M5）与编辑器共用。
 *
 * ## 导出前校验
 *
 * 10.2「导出项目」行：导出前跑一次完整校验（6.4 的五类一致性 + 11.1 的赋值权限）。
 * 校验不通过时**抛错并列出问题位置**，而不是导出一个打不开的文件。
 */
import { ENGINE_VERSION, parseProjectFile } from '@iforge/model'
import type { ProjectFile, ValidationIssue } from '@iforge/model'
import { ForgeError } from '@iforge/num'

import { assertProjectSize, normalizeProjectAssets } from './assets.js'
import type { AssetRepository } from './assets.js'
import { validateOrThrow } from './projects.js'

/**
 * 项目文件 -> 格式化 JSON 文本（10.2「序列化为格式化 JSON，资产内联为 `data:`」）。
 *
 * 顺序：**先内联资产**（`normalizeProjectAssets`）再序列化——反过来的话
 * 体积校验会漏掉刚内联的 data URL。
 */
export async function exportProjectJson(project: ProjectFile, assets: AssetRepository): Promise<string> {
  // 10.2「导出项目」行：导出前跑一次完整校验——**顺序**是先校验再内联资产，
  // 否则刚写坏的文件会先被序列化一遍才报错，白白拷贝一次大文件。
  validateOrThrow(project)
  const inlined = await normalizeProjectAssets(project, assets)
  const json = JSON.stringify(inlined, null, 2)
  assertProjectSize(json)
  return json
}

/** 导出建议文件名（`名称.json`，非法文件名字符替换为 `_`）。 */
export function projectFileName(project: ProjectFile): string {
  const safe = project.meta.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'project'
  return `${safe}.json`
}

/**
 * JSON 文本 -> 项目文件（10.2「导入项目」：读取 → Zod 校验 → 迁移）。
 *
 * @throws {ForgeError} `E_SCHEMA`（结构/一致性）、`E_MIGRATION_FAIL`、`E_ASSET_TOO_LARGE`（超 16MB）
 */
export function importProjectJson(text: string): ProjectFile {
  // 13 第 6 条：大小上限先于解析，避免超大文件拖垮主线程。
  assertProjectSize(text)
  return parseProjectFile(text)
}

/**
 * 导入后写库前的“最后一道”检查：Schema 已通过，但**落盘**还会更新
 * `engineVersion`/`modifiedAt`，这两处也要一起更新，否则列表排序与设置页第 5 项会失真。
 */
export function prepareForSave(project: ProjectFile, now: string): ProjectFile {
  return {
    ...project,
    engineVersion: ENGINE_VERSION,
    meta: { ...project.meta, modifiedAt: now },
  }
}

/** 校验问题清单 -> 可展示文本（编辑器对话框与 CLI `docs:check` 共用）。 */
export function formatIssues(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => `${issue.code} @ ${issue.where}${issue.message ? ` — ${issue.message}` : ''}`)
}

/** 校验失败时统一抛 `E_SCHEMA`（带清单），供调用方直接展示。 */
export function throwIssues(issues: readonly ValidationIssue[]): never {
  throw new ForgeError('E_SCHEMA', { message: formatIssues(issues).join('\n') })
}
