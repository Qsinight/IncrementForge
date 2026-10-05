/**
 * 单文件产物的 HTML 模板（TECH_DESIGN 17.3、11.1 的“模板 index.html + `<script>` 注入 project JSON”）。
 *
 * ## 转义：`</script>` 是这里唯一的正确性问题
 *
 * 项目数据里**一定**可能出现 `</script>` —— 条目的 `description` 是用户自由输入的文本，
 * 而 `JSON.stringify` **不会**转义 `/`。因此必须把 `</` 换成 `<\/`（JSON 里 `\/` 等价于 `/`，
 * 解析结果完全相同，但不会提前闭合 `<script>` 标签）。
 *
 * 同理 `<!--` 也要处理：HTML 解析器在 `<script>` 里对 `<!--` 开头的“脚本数据转义状态”有一套
 * 特殊规则，`<!--` + `</script>` 组合会让浏览器提前结束脚本。
 *
 * 这与 M4 的 `buildSrcdoc` 是**同一个坑**（`session.ts` 里也有这段转义），但两处的载体不同：
 * 那里转义的是 esbuild 产物，这里转义的是用户数据。两处都必须转——只改一处会得到
 * “作者描述里写了 `</script>` 之后预览正常、导出后整页白屏”的诡异现象。
 *
 * ## 主题：`<html data-theme>` 与页面/条目主题是三套命名空间（7.8）
 *
 * 17.3 的模板把 `data-theme` 写在 `<html>` 上。打包产物里只有游戏视图，没有编辑器外壳
 * （D-42），所以这里的 `data-theme` 表达的是**游戏侧**的主题入口；
 * 页面主题（`--iforge-page-*`）与条目主题（`--iforge-entry-*`）由 `AppView` 在运行期
 * 按 `PageDef.theme` / `entries[i].theme` 施加到根节点（`ui-kit` 的 `themeToCss`）。
 *
 * 底色因此写成 `var(--iforge-page-bg, #14161a)` 而不是字面量：见下面模板正文里的注释。
 */
import type { ProjectFile } from '@iforge/model'

/** 产物引导数据的 `meta`（17.3）。 */
export interface BundleMeta {
  engineVersion: string
  /** ISO8601。 */
  builtAt: string
  fingerprint: string
  /** 存档位（V1.0 固定 `main`，PRD 补充 8）。 */
  slotId: string
  /** 项目 id（存档键用；打包态没有 IndexedDB 的 id，由指纹派生）。 */
  projectId: string
}

/** 注入到 `window.__IFORGE_BOOTSTRAP__` 的数据结构（17.3）。 */
export interface BootstrapPayload {
  project: ProjectFile
  /** 打包时不带存档：产物是“全新开局”，玩家自己的进度在 `localStorage`（10.3）。 */
  save: null
  meta: BundleMeta
}

/**
 * `<` -> `\u003c`。
 *
 * ## 为什么用 Unicode 转义而不是 `\/` 或 `\!`
 *
 * 需要被防住的是 HTML 解析器的“脚本数据”规则的**两个**入口：
 * `</script`（任意大小写）与 `<!--`（进入脚本数据转义状态，配 `</script>` 使用）。
 *
 * - `<\/`：只解决第一个，且在 **HTML 属性值之外**完全合法（JSON 允许 `\/`）；
 * - `<\!`：**非法**。`JSON.parse` 会报 “Bad escaped character”，等于把产物做坏了。
 *
 * `\u003c` 是 JSON 规范里的合法转义，解析结果与 `<` 完全相同；运行时读到的仍然是
 * `window.__IFORGE_BOOTSTRAP__` 里的原始字符串，而 HTML 解析器看到的序列里没有 `<`，
 * 因此两个入口同时被堵住。
 *
 * 只转义 `<`（不转 `>`/`&`）：它们在 `<script>` 里不构成解析入口，而转义它们会
 * 破坏 JS 源码里的比较运算符与位运算（`a >> b`、`x & y`）。
 */
export function escapeForScript(json: string): string {
  return json.replace(/</g, '\\u003c')
}

/** 产物里的项目 id（由指纹派生，见 `local-sink.ts` 的 `packagedProjectId`）。 */
export function bundleProjectId(fingerprint: string): string {
  return `pkg-${fingerprint.slice(0, 12)}`
}

/** 组装 `window.__IFORGE_BOOTSTRAP__` 的赋值语句（17.3 的第一段内联脚本）。 */
export function renderBootstrapScript(payload: BootstrapPayload): string {
  return `window.__IFORGE_BOOTSTRAP__=${escapeForScript(JSON.stringify(payload))};`
}

/** 模板参数。 */
export interface RenderOptions {
  project: ProjectFile
  meta: BundleMeta
  /** 运行时 IIFE（已含 CSS 文本，单文件无外部资源）。 */
  runtimeSource: string
  /** 可选的额外 `<style>`（例如把自定义页面/条目主题预置到 `:root`）。 */
  extraCss?: string
}

/**
 * 渲染完整的单文件 HTML（17.3）。
 *
 * 结构与 17.3 的示例一致，只多两处：
 * - `<meta name="generator" content="IncrementForge <engineVersion>">`：便于排查“产物是哪个版本打的”；
 * - `<noscript>`：离线打开时若作者禁用了 JS，至少能看到项目名而不是一片空白。
 */
export function renderBundleHtml(options: RenderOptions): string {
  const { project, meta, runtimeSource } = options
  const title = escapeHtml(project.meta.name)
  const description = escapeHtml(project.meta.description)
  const styles = options.extraCss ? `<style>${options.extraCss}</style>` : ''
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="IncrementForge ${escapeHtml(meta.engineVersion)}">
<meta name="description" content="${description}">
<title>${title}</title>
<style>
/* 内联布局与主题基础样式（11.1「模板 index.html」、11.2「图标内联 SVG path」）。
   底色/文字色走 CSS 变量 + 兜底值，不写死颜色：html 的画布与 body 都要跟随
   **页面主题**（--iforge-page-*，7.8/17.3；运行时由 AppView 写到
   documentElement，见 runtime-shell 的 view/theme.ts）。写死暗色时，html
   一旦有背景，body 的背景就**不再向画布传播**，于是任何超出 body 盒子的区域
   都是那个暗色——浅色主题下就是一条黑边。兜底值保证脚本执行前仍是一份与
   page-dark 一致的暗色，不闪白。 */
html,body{margin:0;padding:0;height:100%;background:var(--iforge-page-bg,#14161a);color:var(--iforge-page-text,#e8eaed)}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
#iforge-root,#app{height:100%}
.iforge-boot-error{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;padding:24px;color:#ff5c5c}
</style>${styles}
</head>
<body class="iforge-game">
<div id="app"></div>
<noscript><p class="iforge-boot-error">本游戏需要启用 JavaScript 才能运行。</p></noscript>
<script>${renderBootstrapScript({ project, save: null, meta })}</script>
<script>${runtimeSource}</script>
</body>
</html>
`
}

/** HTML 文本/属性转义（只用于 `<title>` / `meta`，那里的内容是项目名与描述）。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * 预置页面/条目主题 CSS（11.1 第 1 步“自定义主题内联为 CSS 文本”）。
 *
 * ## 为什么自定义主题必须在这里内联
 *
 * `PageDef.theme` / `entries[i].theme` 的 `kind: 'data'` 装的是 **CSS 文本**（6.1 的 `ThemeRef`）。
 * 运行时 `AppView` 会在挂载时把它写进一个 `<style>`，所以产物本身其实不需要预置——
 * 但预置有一个实际好处：**首帧不闪**。React 挂载发生在 `DOMContentLoaded` 之后，
 * 不预置的话用户会看到一帧默认白底 + 黑字，然后才变成作者的主题。
 *
 * ## 为什么过滤 `</style>` 逃逸
 *
 * 自定义主题是**用户输入的 CSS**（13 第 5 条）。`ui-kit` 的 `sanitizeThemeCss` 已经把
 * `<`/`>` 转义过，但 `ProjectFile` 可以被手改（10.2「导入项目」允许手写 JSON），
 * 绕过上传通道。因此模板渲染时**再兜一次底**：把 `</` 转义，防止闭合 `<style>` 后
 * 注入任意 HTML/脚本。这是 13 第 5 条要求“转义 `<`/`>` 以防闭合 `</style>` 逃逸”
 * 在产物侧的落地。
 */
export function renderThemeCss(themeCss: readonly string[]): string {
  const joined = themeCss.filter((css) => css.trim().length > 0).join('\n')
  if (joined.length === 0) return ''
  return joined.replace(/</g, '\\3c ')
}
