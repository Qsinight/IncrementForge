/**
 * “打包”动作（TECH_DESIGN 11.1 的构建管线、7.1 顶部标题栏的“打包”、17.5 的 M5 交付标准）。
 *
 * ## 编辑器里怎么拿到运行时产物
 *
 * 11.1 的管线要先把运行时打成 IIFE。浏览器里没有 esbuild 的原生绑定，但
 * `apps/editor/vite/iforge-runtime-shell.ts` 已经在**构建期**把运行时编译成字符串常量
 * （虚拟模块），打包时直接用它——不需要给浏览器塞一个 esbuild-wasm。
 *
 * ```
 * 虚拟模块 virtual:iforge-runtime-shell（iframe-entry.ts）
 *          ↓ 预览注入物（挂载点 #iforge-root）
 * PreviewFrame 的 srcdoc（预览）                                ← M4
 *
 * 虚拟模块 virtual:iforge-standalone-runtime（standalone-entry.ts）
 *          ↓ 打包产物运行时（挂载点 #app）
 * packageGame({ runtimeSource })（打包）                        ← M5
 * ```
 *
 * 两份都来自**同一棵** `apps/runtime-shell`（共用 `boot.ts` 与同一棵 `AppView`，ADR-03），
 * 差别只在 I/O 边界与**挂载点**上。
 *
 * ### 为什么打包**不能**复用预览那份注入物（缺陷：产物上半屏留白）
 *
 * | | 入口 | 挂载点 | 谁提供挂载点 |
 * | --- | --- | --- | --- |
 * | 预览 | `iframe-entry.ts` | `#iforge-root` | 宿主写在 `srcdoc` 里（9.1） |
 * | 打包 | `standalone-entry.ts` | `#app` | 打包模板 `renderBundleHtml` 写在 `<body>` 里（17.3） |
 *
 * 误用预览那份时，`iframe-entry` 找不到 `#iforge-root` 就**自己新建一个挂到 `body` 末尾**，
 * 于是模板里那个**空**的 `#app`（模板 CSS 给了 `height: 100%`）留在游戏**上方整整一屏**：
 * 文档高度变成两屏，作者看到的是“页面上半部分一大片留白、往下滚才看到游戏”，
 * 而数据/点击/导航这类功能断言**全绿**。`packages/build/src/bundle.ts` 的
 * `STANDALONE_ENTRY` 注释早就写明了这条（“不是 `iframe-entry.ts`……会永远停在空白页”）——
 * CLI 一直是对的，错的是编辑器这一侧。
 *
 * ## 资产必须先内联（10.1「保存/导出规范化」）
 *
 * 项目文件里的 `IconRef{ kind: 'asset' }` 在单文件产物里**无解**（没有资产库），
 * 图标会变空白。因此打包前要走一遍 `normalizeProjectAssets()`——与 10.2 的导出同一条路径，
 * 这也是 10.1「打包与『导出存档』走同一条序列化路径」的直接推论。
 * 校验失败不阻断内联（内联只是把 id 换成 data URL），问题由 `validateForPack` 报出来。
 */
import { packageGame, validateForPack } from '@iforge/build'
import type { PackageOutcome } from '@iforge/build'
import { ENGINE_VERSION } from '@iforge/model'
import type { ProjectFile, ValidationIssue } from '@iforge/model'
import { normalizeProjectAssets } from '@iforge/persist'

import runtimeStandaloneSource from 'virtual:iforge-standalone-runtime'

import { useEditorStore } from '../../stores/editor.js'
import { usePreviewStore } from '../../stores/preview.js'
import { useProjectStore } from '../../stores/project.js'
import { downloadText, recordIssues } from './projectIo.js'
import type { ProjectIo } from './projectIo.js'

/** 打包结果（供 UI 与测试断言）。 */
export interface PackageRun {
  ok: boolean
  fileName?: string
  issues: ValidationIssue[]
  bytes?: number
  gzipBytes?: number
  overBudget?: boolean
  fingerprint?: string
}

/**
 * 打包并下载。
 *
 * 与 `saveProject`/`exportProject` 一致地**不抛错**：结果通过返回值与 `issues` 传递，
 * 由 `App.tsx` 决定弹哪个对话框（6.4 的问题清单口径）。
 */
export async function packageProject(io: ProjectIo): Promise<PackageRun> {
  const { project } = useProjectStore.getState()
  const notify = useEditorStore.getState().notify

  // 10.1：先内联资产（`kind:'asset'` -> `kind:'data'`），否则产物里的图标/主题是空白。
  let inlined: ProjectFile
  try {
    inlined = await normalizeProjectAssets(project, io.assets)
  } catch (error) {
    usePreviewStore.getState().setPackaging(null)
    notify('package.failed', 'error')
    const issues = issuesOfError(error)
    recordIssues(issues)
    return { ok: false, issues }
  }

  const outcome: PackageOutcome = packageGame({
    project: inlined,
    runtimeSource: runtimeStandaloneSource,
    engineVersion: ENGINE_VERSION,
    // 存档位固定 `main`（PRD 补充 8）：产物不携带存档，玩家的进度在 `localStorage`（10.3）。
    slotId: 'main',
    builtAt: new Date().toISOString(),
  })

  if (!outcome.ok) {
    usePreviewStore.getState().setPackaging(null)
    notify('package.blocked', 'error')
    // 11.1「中止并列出问题位置」：清单要进 `App.tsx` 读的那一份（`issuesOfLastOperation()`），
    // 否则对话框打开时里面是空的，作者既知道不了被打断也不知道该改哪一行。
    recordIssues(outcome.issues)
    return { ok: false, issues: outcome.issues }
  }

  downloadText(outcome.fileName, outcome.html, 'text/html;charset=utf-8')
  recordIssues([])
  usePreviewStore.getState().setPackaging({
    fileName: outcome.fileName,
    bytes: outcome.bytes,
    gzipBytes: outcome.gzipBytes,
    overBudget: outcome.overBudget,
    fingerprint: outcome.meta.fingerprint,
    builtAt: outcome.meta.builtAt,
  })
  notify(outcome.overBudget ? 'package.overBudget' : 'package.done', outcome.overBudget ? 'error' : 'info')
  return {
    ok: true,
    fileName: outcome.fileName,
    issues: [],
    bytes: outcome.bytes,
    gzipBytes: outcome.gzipBytes,
    overBudget: outcome.overBudget,
    fingerprint: outcome.meta.fingerprint,
  }
}

/** 只跑校验不打包（编辑器设置页/对话框的“打包前检查”入口；11.1 的 7 条）。 */
export function preflightProject(project: ProjectFile = useProjectStore.getState().project): ValidationIssue[] {
  return validateForPack(project)
}

function issuesOfError(error: unknown): ValidationIssue[] {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: unknown }).issues
    if (Array.isArray(issues)) return issues as ValidationIssue[]
  }
  return [{ code: 'E_ASSET_TOO_LARGE', where: '', message: error instanceof Error ? error.message : String(error) }]
}
