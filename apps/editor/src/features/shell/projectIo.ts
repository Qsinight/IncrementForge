/**
 * 项目生命周期动作（TECH_DESIGN 7.9「新建、保存、导入、导出」、10.2、7.2 `previewStore`）。
 *
 * ## 四条动作与文档的对应
 *
 * | 动作 | 实现 |
 * | --- | --- |
 * | 新建 | `createDefaultProject()` + 新 `projectId` + 清空历史栈 + 重建 UI/影子（7.9） |
 * | 保存 | `projects.save()`（Zod + 一致性校验 → 事务写 → 更新 `modifiedAt`/`engineVersion`） |
 * | 导入 | 读文本 → `importProjectJson()`（校验 + 迁移）→ 覆盖当前项目（D-33 只给“覆盖/取消”） |
 * | 导出 | `exportProjectJson()`（先校验、再内联资产）→ 下载 |
 *
 * ## 运行时赋值不参与保存（PRD 补充 6、R-08）
 *
 * 保存只写 `projectStore.project`。预览/影子运行时里的赋值留在存档侧（`runtime` 的 `save.ts`），
 * 两者不合并——合并就等于让游玩行为改写作者的项目文件。
 */
import { ENGINE_VERSION, createDefaultProject, createExampleProject } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'
import type { AssetRepository, ProjectRepository } from '@iforge/persist'
import { exportProjectJson, importProjectJson, loadProjectAssets, projectFileName } from '@iforge/persist'
import type { ValidationIssue } from '@iforge/model'

import { useEditorStore } from '../../stores/editor.js'
import { useProjectStore, newProjectId as newProjectStoreId } from '../../stores/project.js'
import { invalidateShadow } from '../../stores/shadowStore.js'
import { useSettingsStore } from '../../stores/settings.js'

/** 运行期依赖（由 `main.tsx` 注入，便于测试替换）。 */
export interface ProjectIo {
  projects: ProjectRepository
  assets: AssetRepository
  meta: {
    set(key: string, value: unknown): Promise<void>
    get<T>(key: string): Promise<T | undefined>
    delete(key: string): Promise<void>
  }
}

/** 弹出的问题清单（保存被校验阻断时展示）。 */
let lastIssues: readonly ValidationIssue[] = []

/** 最近一次校验问题（对话框与测试读取）。 */
export function issuesOfLastOperation(): readonly ValidationIssue[] {
  return lastIssues
}

/**
 * 登记一批校验问题，供 `App.tsx` 的“问题清单”对话框展示（6.4）。
 *
 * ## 为什么需要这个入口
 *
 * 保存、导入、导出三条路径都自己往 `lastIssues` 写；而**打包**（`packageGame.ts`）只把问题
 * 作为返回值抛给 `App.tsx`，`App.tsx` 随即 `setIssuesOpen(true)` 打开同一个对话框——
 * 但对话框读的是 `issuesOfLastOperation()`，那里面还是上一次（多半是空）的值。
 * 于是 11.1「任一失败即中止并列出问题位置」在界面上退化成“弹了个框，里面写着没有问题”。
 *
 * 打包不是“项目生命周期”动作（它不落库、不改 `projectId`），因此不复用 `saveProject`；
 * 但它与保存/导出共用同一个问题清单对话框，就必须走同一个登记入口。
 */
export function recordIssues(issues: readonly ValidationIssue[]): void {
  lastIssues = issues
}

/** 新建项目（7.9）：默认模板 + 新 id + 清空历史与影子。 */
export function newProject(io: ProjectIo): ProjectFile {
  const project = createDefaultProject({ engineVersion: ENGINE_VERSION })
  const projectId = newProjectStoreId()
  useProjectStore.getState().replace(project, projectId)
  useEditorStore.getState().resetUi()
  invalidateShadow()
  void io.meta.set('editor.currentProjectId', projectId)
  useSettingsStore.getState().setCurrentProjectId(projectId)
  lastIssues = []
  return project
}

/** 用示例项目新建（17.2 的示例夹具，供作者起步与 E2E 使用）。 */
export function newExampleProject(io: ProjectIo): ProjectFile {
  const project = createExampleProject()
  const projectId = newProjectStoreId()
  useProjectStore.getState().replace(project, projectId)
  useEditorStore.getState().resetUi()
  invalidateShadow()
  void io.meta.set('editor.currentProjectId', projectId)
  useSettingsStore.getState().setCurrentProjectId(projectId)
  lastIssues = []
  return project
}

/** 保存项目（7.9）。校验不通过时**不写库**，并把问题清单留在 `issuesOfLastOperation()`。 */
export async function saveProject(io: ProjectIo): Promise<{ ok: boolean; issues: readonly ValidationIssue[] }> {
  const { project, projectId, markSaved } = useProjectStore.getState()
  try {
    const saved = await io.projects.save(projectId, project, { engineVersion: ENGINE_VERSION })
    markSaved(new Date().toISOString(), saved)
    // 指针与偏好一起落盘（10.1 表的 `meta` 行）：下次启动据此载入同一个项目。
    void io.meta.set('editor.currentProjectId', projectId)
    useSettingsStore.getState().setCurrentProjectId(projectId)
    lastIssues = []
    useEditorStore.getState().notify('lifecycle.saved')
    return { ok: true, issues: [] }
  } catch (error) {
    const issues = issuesFromError(error)
    lastIssues = issues
    useEditorStore.getState().notify(`lifecycle.saveBlocked`, 'error')
    return { ok: false, issues }
  }
}

/** 导出项目文件（10.2「导出项目」：先校验、资产内联为 data:、下载）。 */
export async function exportProject(io: ProjectIo): Promise<{ ok: boolean; issues: readonly ValidationIssue[] }> {
  const { project } = useProjectStore.getState()
  try {
    const json = await exportProjectJson(project, io.assets)
    downloadText(projectFileName(project), json, 'application/json')
    lastIssues = []
    useEditorStore.getState().notify('lifecycle.exportDone')
    return { ok: true, issues: [] }
  } catch (error) {
    const issues = issuesFromError(error)
    lastIssues = issues
    useEditorStore.getState().notify(`lifecycle.saveFailed`, 'error')
    return { ok: false, issues }
  }
}

/**
 * 导入项目（10.2「导入项目」）。
 *
 * V1.0 单项目管理：冲突处理只提供“覆盖当前项目 / 取消导入”（D-33），
 * “另存为新项目”属多项目预留接口，**不实现**（15「UI 暴露口径」）。
 *
 * @param text 项目文件文本
 * @param overwrite 是否确认覆盖（未确认时只做校验，不落库）
 */
export async function importProject(
  io: ProjectIo,
  text: string,
  overwrite: boolean,
): Promise<{ ok: boolean; issues: readonly ValidationIssue[]; validated: ProjectFile | null }> {
  let parsed: ProjectFile
  try {
    parsed = importProjectJson(text)
  } catch (error) {
    const issues = issuesFromError(error)
    lastIssues = issues
    return { ok: false, issues, validated: null }
  }
  if (!overwrite) return { ok: false, issues: [], validated: parsed }

  // 资产引用解析（10.1「载入」）：`kind:'asset'` -> data URL。
  const resolved = await loadProjectAssets(parsed, io.assets)
  const state = useProjectStore.getState()
  state.replace(resolved, state.projectId)
  invalidateShadow()
  lastIssues = []
  useEditorStore.getState().notify('lifecycle.importDone')
  return { ok: true, issues: [], validated: resolved }
}

/**
 * 载入上次打开的项目（`meta` 指针；不存在则回落到最近修改的项目）。
 *
 * ## 为什么不能只认 `meta` 指针
 *
 * 首屏启动时指针可能**还没写过**：项目是在 `projectStore` 初始化时建出来的，
 * 没有任何动作写过 `editor.currentProjectId`。若这里“指针缺失就新建默认模板”，
 * 用户保存过的项目会在刷新后被一份空模板顶掉（列表里的项目仍然存在，却打不开）。
 * 因此回落顺序是：**指针 → 最近修改的项目（`by-modifiedAt` 索引）→ 全新模板并落盘**。
 *
 * V1.0 单项目（D-33），所以“最近修改的那一个”就是“上一个”；多项目管理落地时
 * 这一层换成 `ProjectRegistry.list()/open()`，本函数签名不变（15）。
 */
export async function restoreLastProject(io: ProjectIo): Promise<ProjectFile> {
  const pointer = await io.meta.get<string>('editor.currentProjectId')
  const candidates: string[] = pointer ? [pointer] : (await io.projects.list()).map((record) => record.projectId)

  for (const projectId of candidates) {
    const stored = await io.projects.get(projectId)
    if (!stored) continue
    // 资产引用解析（10.1「载入」）：`kind:'asset'` -> data URL。
    const resolved = await loadProjectAssets(stored, io.assets)
    const state = useProjectStore.getState()
    state.replace(resolved, projectId)
    useSettingsStore.getState().setCurrentProjectId(projectId)
    void io.meta.set('editor.currentProjectId', projectId)
    return resolved
  }

  // 库里一个项目都没有：新建默认模板**并落盘**（10.2 表「新建项目」行），
  // 否则用户第一次“保存”之前刷新页面会得到另一个新的 projectId。
  const project = createDefaultProject({ engineVersion: ENGINE_VERSION })
  const projectId = newProjectStoreId()
  useProjectStore.getState().replace(project, projectId)
  useSettingsStore.getState().setCurrentProjectId(projectId)
  void io.meta.set('editor.currentProjectId', projectId)
  await saveProject(io)
  return project
}

/** 上传资产落库并返回 `IconRef`/`ThemeRef`（10.1「上传落库」，D-12）。 */
export async function storeAsset(
  io: ProjectIo,
  asset: { kind: 'icon' | 'theme'; mime: string; data: string; name: string },
): Promise<{ kind: 'asset'; value: string }> {
  const row = await io.assets.put(asset)
  return { kind: 'asset', value: row.assetId }
}

/** 下载文本文件（10.2 的“下载 `*.json`”）。测试环境用 `URL.createObjectURL` 桩。 */
export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function issuesFromError(error: unknown): readonly ValidationIssue[] {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: readonly ValidationIssue[] }).issues
    if (Array.isArray(issues)) return issues
  }
  const message = error instanceof Error ? error.message : String(error)
  return [{ code: 'E_SCHEMA', where: '', message }]
}
