/**
 * **iframe 注入入口**（TECH_DESIGN 9.1「运行时脚本通过构建产物注入 `srcdoc`」、9.3）。
 *
 * ## 打包形态
 *
 * 编辑器的 Vite 插件（`apps/editor/vite.config.ts` 的 `iforgeRuntimeShell()`）用 esbuild
 * 把**本文件**打成单文件 IIFE，宿主再把它内联进 `srcdoc`：
 *
 * ```html
 * <iframe sandbox="allow-scripts allow-pointer-lock" srcdoc="
 *   <style>game.css 的文本</style>
 *   <div id="iforge-root"></div>
 *   <script>本文件的编译产物</script>
 * ">
 * ```
 *
 * 因此本文件**不能**有任何运行时外部依赖：CSS 以 `?inline` 文本形式内联、
 * React/`@iforge/*` 全部打进产物。这也正是 M5 单文件打包要复用的同一份入口（ADR-05）。
 *
 * ## 为什么没有 `allow-same-origin`
 *
 * 9.1 明确不加。代价是 `postMessage` 只能用 `targetOrigin: '*'`、无法访问父页面的
 * DOM/存储；收益是表达式死循环或内存暴涨**不会**拖垮编辑器（R-11、13 第 3 条）。
 * 安全由 `sessionId` + `kind` 白名单 + 长度上限保证（9.2、R-19，见 `protocol.ts`）。
 */
import { mountGameRuntime } from './boot.js'

/**
 * 样式以 `?inline` 文本形式导入并自注入。
 *
 * `?inline` 是 Vite 与 esbuild（本项目的 esbuild 插件里手写了同名 `onLoad`）都认识的
 * 后缀：拿到的是**CSS 文本**而不是副作用导入。这样编译产物是单个 JS 文件，
 * 宿主不需要再单独内联一个 `<style>` 或 `<link>`。
 */
import gameCss from './game.css?inline'

/**
 * 挂载点 id（宿主在 `srcdoc` 里放一个空 div；没有就自己建一个）。
 *
 * `FALLBACK_ROOT_ID` 是打包模板 `renderBundleHtml` 用的 id。正常情况下打包产物内联的是
 * `standalone-entry.ts`（挂载点就是 `#app`），本文件只服务预览；但把 `#app` 也列为候选
 * 是**兜底**：万一这份注入物被误打进产物，`document.getElementById(ROOT_ID)` 会返回 `null`，
 * 而“新建一个挂到 `body` 末尾”会在那个**空**的 `#app`（模板 CSS 给了 `height: 100%`）
 * 下方再撑出一整屏——作者看到的是“页面上半部分一大片留白、往下滚才看到游戏”，
 * 而数据/点击/导航这类功能断言**全绿**。复用模板给的挂载点从结构上排除了这一类失效。
 */
const ROOT_ID = 'iforge-root'
const FALLBACK_ROOT_ID = 'app'

/** 挂载点上承载宿主会话 id 的属性（与 `session.ts` 的 `buildSrcdoc` 成对）。 */
const SESSION_ATTR = 'data-session-id'

function injectStyles(): void {
  const id = 'iforge-game-style'
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = gameCss
  document.head.append(style)
}

/** 启动：先注入样式与根节点，再等 `host:init`（9.3 第 1 步）。 */
function bootstrap(): void {
  injectStyles()
  // 优先用宿主给的 `#iforge-root`（预览的 `srcdoc`）；退回打包模板的 `#app`；
  // 两者都没有才自己建一个（见 `FALLBACK_ROOT_ID` 的注释）。
  const existing = document.getElementById(ROOT_ID) ?? document.getElementById(FALLBACK_ROOT_ID)
  const element = existing ?? document.createElement('div')
  if (!existing) {
    element.id = ROOT_ID
    document.body.append(element)
  }
  mountGameRuntime({ element, sessionId: element.getAttribute(SESSION_ATTR) ?? undefined })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true })
} else {
  bootstrap()
}
