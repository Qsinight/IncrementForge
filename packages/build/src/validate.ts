/**
 * 打包前校验（TECH_DESIGN 11.1 的 7 条，11.1「任一失败即中止并列出问题位置」）。
 *
 * ## 与保存/导出校验的关系
 *
 * 11.1 的前 5 条与 6.4 的 `validateProject()` **完全重合**（表达式、赋值权限、引用完整性、
 * 页面唯一性、`create()` 的 spec），因此这里不重写一套，而是直接复用模型包的那个函数——
 * 两份规则迟早会分叉，而分叉的后果是“能保存但打不出包”，作者完全无法理解。
 *
 * 本模块只补 11.1 里**项目校验不管**的三条：
 *
 * | # | 11.1 的检查 | 落点 |
 * | --- | --- | --- |
 * | 6 | 资产体积与格式合规（`E_ASSET_TOO_LARGE`） | `checkAssets()` |
 * | 7 | `tickRate > 0` / `maxFrameStep > 0` / `autosaveInterval > 0` / `offlineCap ≥ 0` | `checkSettings()` |
 * | — | 打包态特有的“资产必须已内联”前置条件 | `checkAssets()` |
 *
 * 第 6 条里的“资产必须已内联”是本包引入的一条**额外**约束：打包产物是**单个 HTML 文件**
 * （17.3），里面没有 IndexedDB，也没有资产库；`IconRef{ kind: 'asset' }` 在产物里会解析成
 * 一个查不到记录的 id，图标变成空白。这类问题在预览里不可见（编辑器把引用解析成了 data URL），
 * 只会在产物里暴露——所以必须在打包前拦。
 */
import { validateProject } from '@iforge/model'
import type { ProjectFile, ValidationIssue } from '@iforge/model'
import { MAX_ASSET_BYTES, MAX_PROJECT_BYTES } from '@iforge/ui-kit'
import type { IconRef, ThemeRef } from '@iforge/model'

/** 打包前的全部检查（11.1 的 7 条）。 */
export function validateForPack(project: ProjectFile): ValidationIssue[] {
  return [...validateProject(project), ...checkSettings(project), ...checkAssets(project)]
}

/**
 * 第 7 条：设置项的下界。
 *
 * `tickRate = 0` 会让 `1000 / tickRate` 得到 `Infinity`、`step` 变成 `0`，
 * 主循环的步数计划完全失灵（表现是“游戏不动了且不报错”）；`maxFrameStep = 0` 让
 * `realDt = min(now - last, 0) = 0`，真实时间永远不推进，`nPlan` 恒为 0；
 * `autosaveInterval = 0` 则每个 tick 都写存档。
 *
 * 这些都**不是**编辑器表单能完全挡住的：设置可被项目文件手改、`offlineCap` 还能被
 * 表达式改。11.1 把它们列为打包前的硬门槛正是因此。
 */
export function checkSettings(project: ProjectFile): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const settings = project.settings
  const positive: { key: string; value: number }[] = [
    { key: 'tickRate', value: settings.tickRate },
    { key: 'maxFrameStep', value: settings.maxFrameStep },
    { key: 'autosaveInterval', value: settings.autosaveInterval },
  ]
  for (const item of positive) {
    if (!Number.isFinite(item.value) || item.value <= 0) {
      issues.push({
        code: 'E_SCHEMA',
        where: `settings.${item.key}`,
        message: `必须是大于 0 的有限数（收到 ${item.value}），否则运行时主循环会停摆`,
      })
    }
  }
  if (!Number.isFinite(settings.offlineCap) || settings.offlineCap < 0) {
    issues.push({
      code: 'E_SCHEMA',
      where: 'settings.offlineCap',
      message: `必须是 ≥ 0 的有限数（收到 ${settings.offlineCap}）`,
    })
  }
  return issues
}

/**
 * 第 6 条：资产。
 *
 * 三个层次，从便宜到贵：
 * 1. **必须已内联**：`kind: 'asset'` 在单文件产物里无解——直接报错并指出位置；
 * 2. **单项体积**：单个 `data:` 超过 64KB（`E_ASSET_TOO_LARGE`，13 第 4 条）就中止；
 * 3. **整体体积**：内联后的项目 JSON 超过 16MB（13 第 6 条）就中止。
 *
 * 为什么不在这里调 `sanitizeSvg`（13 第 4 条的白名单过滤）：过滤发生在**上传落库**时
 * （`ui-kit` 的 `imageFileToDataUrl`），已经在库里的资产是过滤过的。这里再做一次是重复劳动，
 * 而且会对**合法的**矢量图（例如作者手写的、含 `<title>` 的图标）产生误报。
 */
export function checkAssets(project: ProjectFile): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  // 超限的 data URL 只报一次并给出全部位置：同一个图标被 20 个条目引用时，
  // 20 条一模一样的行会把真正有用的那一条淹没。
  const oversized = new Map<string, string[]>()

  const visit = (ref: IconRef | ThemeRef | undefined, where: string): void => {
    if (!ref || typeof ref !== 'object') return
    if (ref.kind === 'asset') {
      issues.push({
        code: 'E_ASSET_TOO_LARGE',
        where,
        message:
          `资产引用 "${ref.value}" 未内联；单文件产物里没有资产库，该图标/主题会变成空白。` +
          '请先保存或导出项目（10.1「保存/导出规范化」会把被引用的资产内联为 data:）',
      })
      return
    }
    if (ref.kind !== 'data') return
    const size = byteLength(ref.value)
    if (size <= MAX_ASSET_BYTES) return
    const locations = oversized.get(ref.value)
    if (locations) locations.push(where)
    else oversized.set(ref.value, [where])
  }

  project.resources.forEach((item, i) => visit(item.icon, `resources[${i}].icon`))
  project.generators.forEach((item, i) => visit(item.icon, `generators[${i}].icon`))
  project.upgrades.forEach((item, i) => visit(item.icon, `upgrades[${i}].icon`))
  project.pages.forEach((page, i) => {
    visit(page.icon, `pages[${i}].icon`)
    visit(page.theme, `pages[${i}].theme`)
    page.entries.forEach((entry, j) => visit(entry.theme, `pages[${i}].entries[${j}].theme`))
  })

  for (const [value, locations] of oversized) {
    issues.push({
      code: 'E_ASSET_TOO_LARGE',
      where: locations[0]!,
      message:
        `单个资产 ${byteLength(value)} 字节，超过 ${MAX_ASSET_BYTES} 字节上限（11.1 第 6 条 / 13 第 4 条）；` + `引用位置：${locations.join('、')}`,
    })
  }

  const json = JSON.stringify(project)
  if (byteLength(json) > MAX_PROJECT_BYTES) {
    issues.push({
      code: 'E_ASSET_TOO_LARGE',
      where: '',
      message: `项目文件 ${byteLength(json)} 字节，超过 ${MAX_PROJECT_BYTES} 字节上限（13 第 6 条）`,
    })
  }
  return issues
}

/** UTF-8 字节数（`data:` URL 与 JSON 的体积都按字节算，不是字符数）。 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** 把问题清单格式化成可读文本（编辑器对话框与 CLI 共用，10.2 `formatIssues` 的同款口径）。 */
export function formatPackIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((issue) => `${issue.code} @ ${issue.where || '(项目根)'} — ${issue.message}`).join('\n')
}
