/**
 * 单文件打包的编排（TECH_DESIGN 11.1 的构建管线、11.2 的体积预算）。
 *
 * ```
 * 项目内存模型
 *   → 打包前校验（7 条，11.1）
 *   → 资产内联为 data:（10.1「保存/导出规范化」）
 *   → 运行时产物 runtime IIFE（单文件、无外部依赖）
 *   → 模板 + `<script>` 注入 project JSON（17.3）
 *   → dist/<项目名>.html（单文件、离线可玩）
 * ```
 *
 * ## 与 11.1 的两处实现差异（均为**有理由**的偏离，不是漏做）
 *
 * | 11.1 原文 | 本实现 | 为什么 |
 * | --- | --- | --- |
 * | 运行时产物 `vite build` **lib 模式** + `vite-plugin-singlefile` 内联 JS/CSS | esbuild 直接打成**单文件 IIFE**（CSS 以 `?inline` 内联） | 产物本来就要单文件：esbuild 一步到位，而 vite lib 模式产出的是 `index.js` + `index.css` 两个文件，还要靠 singlefile 插件再合成一次——多一层插件就多一处“dev 能跑、build 挂掉”的风险。同一条 esbuild 管线已被 M4 的预览注入物验证过（`apps/editor/vite/iforge-runtime-shell.ts`） |
 * | 打包在编辑器里点“打包”按钮 | `packageGame()` **不关心产物从哪来**：`runtimeSource` 由调用方给 | 编辑器**不能**在浏览器里跑 esbuild。编辑器的 Vite 插件在**构建期**就把运行时编译成字符串常量内联进 bundle（`virtual:iforge-runtime-shell`），打包时直接用它——同一份字节，不存在“两份运行时” |
 *
 * ## 体积预算（11.2：目标产物 < 1.5MB）
 *
 * `packageGame` 不在超限时抛错，而是**如实返回**字节数与 gzip 估算，由调用方决定
 * 是提示还是阻断。理由：1.5MB 是工程目标而不是正确性约束，作者上传几张大图到 1.6MB 时，
 * 直接拒绝打包会让人无处下手（只能回去改图），而提示 + 数字才是可行动的信息。
 */
import { ENGINE_VERSION } from '@iforge/model'
import type { ProjectFile, ValidationIssue } from '@iforge/model'
import { projectFingerprint, gameFileName } from './fingerprint.js'
import { bundleProjectId, renderBundleHtml, renderThemeCss } from './template.js'
import type { BundleMeta } from './template.js'
import { validateForPack } from './validate.js'

/** 11.2 的体积预算：产物 < 1.5MB（gzip < 500KB）。 */
export const SIZE_BUDGET_BYTES = 1.5 * 1024 * 1024

/** gzip 后的体积预算（11.2）。 */
export const SIZE_BUDGET_GZIP_BYTES = 500 * 1024

/** 打包参数。 */
export interface PackageOptions {
  project: ProjectFile
  /** 运行时 IIFE 文本（含 CSS）。空串视为“没给产物”——此时**不**打包并报 `E_SCHEMA`。 */
  runtimeSource: string
  /** ISO8601 打包时间；省略时取当前时间。 */
  builtAt?: string
  /** 引擎版本；省略时用 `@iforge/model` 的 `ENGINE_VERSION`。 */
  engineVersion?: string
  /** 存档位（V1.0 固定 `main`，PRD 补充 8）。 */
  slotId?: string
  /** 跳过打包前校验（仅测试用；11.1 要求“任一失败即中止”）。 */
  skipValidation?: boolean
}

/** 打包成功的结果。 */
export interface PackageResult {
  /** 单文件 HTML 全文。 */
  html: string
  /** 建议文件名（`<项目名>.html`）。 */
  fileName: string
  meta: BundleMeta
  /** 产物的 UTF-8 字节数。 */
  bytes: number
  /** gzip 后字节数（Node 的 `zlib`；不可用时为 `0`）。 */
  gzipBytes: number
  /** 是否超出 11.2 的体积预算。 */
  overBudget: boolean
}

/** 打包失败（11.1「任一失败即中止并列出问题位置」）。 */
export interface PackageFailure {
  ok: false
  issues: ValidationIssue[]
}

export type PackageOutcome = ({ ok: true } & PackageResult) | PackageFailure

/**
 * 打包。**不抛错**：失败时返回 `{ ok: false, issues }`。
 *
 * 编辑器要把问题清单显示在对话框里（6.4 的口径），CLI 要打印后以非 0 退出；
 * 抛错会让两个调用方都要 `try/catch` + 二次解析 message（`persist` 的
 * `issuesFromError` 已经在做这种还原，见 `projectIo.ts`）。
 */
export function packageGame(options: PackageOptions): PackageOutcome {
  const issues = options.skipValidation ? [] : validateForPack(options.project)
  if (issues.length > 0) return { ok: false, issues }

  if (options.runtimeSource.trim().length === 0) {
    return {
      ok: false,
      issues: [{ code: 'E_SCHEMA', where: '', message: '缺少运行时产物（runtimeSource 为空）；无法生成单文件产物' }],
    }
  }

  const engineVersion = options.engineVersion ?? ENGINE_VERSION
  const fingerprint = projectFingerprint(options.project)
  const meta: BundleMeta = {
    engineVersion,
    builtAt: options.builtAt ?? new Date().toISOString(),
    fingerprint,
    slotId: options.slotId ?? 'main',
    projectId: bundleProjectId(fingerprint),
  }

  const html = renderBundleHtml({
    project: options.project,
    meta,
    runtimeSource: options.runtimeSource,
    extraCss: renderThemeCss(collectCustomThemeCss(options.project)),
  })

  const bytes = utf8Length(html)
  const gzipBytes = gzipLength(html)
  return {
    ok: true,
    html,
    fileName: gameFileName(options.project),
    meta,
    bytes,
    gzipBytes,
    overBudget: bytes > SIZE_BUDGET_BYTES,
  }
}

/**
 * 收集项目里所有 `kind: 'data'` 的自定义主题 CSS（11.1 第 1 步）。
 *
 * **去重**：同一个自定义主题被 20 个条目引用时只预置一次——`renderThemeCss` 按文本去重，
 * 否则产物会平白多出 19 份相同的 CSS。
 */
function collectCustomThemeCss(project: ProjectFile): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (theme: { kind: string; value: string } | undefined): void => {
    if (!theme || theme.kind !== 'data') return
    if (seen.has(theme.value)) return
    seen.add(theme.value)
    out.push(theme.value)
  }
  for (const page of project.pages) {
    push(page.theme)
    for (const entry of page.entries) push(entry.theme)
  }
  return out
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * gzip 体积（11.2 的“gzip < 500KB”口径）。
 *
 * ## 这里为什么用**异步** `import('node:zlib')`，而不是 `require`
 *
 * `packageGame()` 是**同步**函数（编辑器在浏览器里点一下就下载，必须同步拿到 HTML），
 * 而 `zlib` 在 ESM 里只有异步入口。两个选项：
 *
 * | 选项 | 结果 |
 * | --- | --- |
 * | `createRequire(import.meta.url)('node:zlib')` | 在 **bundle** 里被 esbuild 静态分析改写，解析失败 |
 * | 预异步加载并缓存 `gzipSync` | `packageGame` 的同步签名不变，而 CLI/Node 侧能拿到真实数字 |
 *
 * 因此这里的口径是：**`gzipBytes` 可能是 `0`（表示不可用），`bytes` 永远可用**。
 * `gzipSync` 由 `warmUpGzip()` 预加载；未预加载时降级为“未知”，而不是抛错——
 * 拿不到 gzip 数字不该让打包失败。
 *
 * 谁调 `warmUpGzip()`：`cli.ts` 在**编译运行时之前**调（那段等待本来就存在，
 * 顺带把 zlib 拉进来零成本）；编辑器的浏览器路径不调（浏览器里没有 zlib）。
 */
/**
 * 动态 `import` 的**变量** specifier。
 *
 * 写成字面量 `import('node:zlib')` 时，Vite 会在浏览器构建里把它“外部化”成一个
 * 抛错��� stub（构建时打印 `Module "node:zlib" has been externalized for browser
 * compatibility`）——它不会让构建失败，但会在控制台留一条警告，且 stub 一旦被求值
 * 就抛 `SyntaxError`。变量形式让 bundler 看不见 specifier，`import()` 保持原样。
 *
 * 兜底 `catch` 仍然必要：浏览器里它是网络 404，控制台同样会记一条失败。
 */
const ZLIB_MODULE = 'node:zlib'

let gzipSync: ((buf: Uint8Array) => { byteLength: number }) | null = null

/** 预加载 `zlib`（Node 侧；浏览器里调用是无害的 no-op，`gzipBytes` 恒为 0）。 */
export async function warmUpGzip(): Promise<void> {
  if (gzipSync !== null) return
  try {
    const specifier: string = ZLIB_MODULE
    const zlib = (await import(/* @vite-ignore */ specifier)) as {
      gzipSync(buf: Uint8Array): { byteLength: number }
    }
    // 只取 `byteLength` 这一个能力，避免把 `zlib` 的完整类型（Buffer 相关）拖进
    // 浏览器侧的 `build` 入口类型图里。
    gzipSync = (buf: Uint8Array) => zlib.gzipSync(buf)
  } catch {
    gzipSync = null
  }
}

function gzipLength(text: string): number {
  if (gzipSync === null) return 0
  try {
    return gzipSync(new TextEncoder().encode(text)).byteLength
  } catch {
    return 0
  }
}
