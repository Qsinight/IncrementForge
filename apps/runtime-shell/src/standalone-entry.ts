/**
 * **打包产物入口**（TECH_DESIGN 11.1、17.3、ADR-05）。
 *
 * ## 与另外两个入口的关系
 *
 * | 入口 | 装配方式 | 用途 |
 * | --- | --- | --- |
 * | `iframe-entry.ts` | 注入 `srcdoc`，等 `host:init` | 编辑器右侧预览（9.1 的不透明源 iframe） |
 * | `main.ts` | 读 `?bootstrap=` / 页面内联的引导数据 | 直挂调试页 |
 * | **`standalone-entry.ts`（本文件）** | 读 `window.__IFORGE_BOOTSTRAP__` 后**直接挂载** | **单文件打包产物**（11.1） |
 *
 * 三者共用 `mountGameRuntime()` 与同一棵 `AppView`（ADR-03），差异只在 I/O 边界上。
 *
 * ## 为什么打包产物不用 iframe（ADR-05）
 *
 * 预览必须隔离（表达式死循环/内存暴涨不拖垮编辑器，R-11），成品没有这个顾虑：
 * 多一层 iframe 就多一次跨窗口通信、多一份内存、多一个 `postMessage` 协议实现，
 * 而游戏视图本来就只有一棵 React 树。
 *
 * ## 为什么“主题切换写 `<html data-theme>`”在这里做（7.8）
 *
 * 17.3 的模板把 `data-theme` 写死在 `<html>` 上，打包产物没有宿主来改它；
 * 页面/条目主题则由 `AppView` 按 `PageDef.theme` 施加到根节点（7.8 的三套命名空间）。
 * 编辑器主题在这里没有意义——产物里只有游戏视图，没有编辑器外壳（D-42）。
 */
import { mountGameRuntime } from './boot.js'
import type { Bootstrap } from './boot.js'

/**
 * 样式以 `?inline` 文本形式导入并自注入（与 `iframe-entry.ts` 同一套机制）。
 *
 * 打包产物是**单个 HTML 文件**：不能引外部 CSS（否则离线打开就是无样式的裸文字），
 * 也不能靠 JS 动态 `import`（那是 ESM 模块，单文件里没有解析器）。
 */
import gameCss from './game.css?inline'

/** 挂载点 id（17.3 的模板里是 `<div id="app">`，与 9.1 的 `iforge-root` 不同）。 */
const ROOT_ID = 'app'

function injectStyles(): void {
  const id = 'iforge-game-style'
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = gameCss
  document.head.append(style)
}

function bootstrap(): void {
  injectStyles()

  const raw = window.__IFORGE_BOOTSTRAP__
  if (!raw) {
    // 模板被改坏（`__IFORGE_BOOTSTRAP__` 缺失）时给出**可读**的失败，而不是白屏。
    // `mountGameRuntime` 在直挂模式下会抛 `直挂模式需要 bootstrap`，那是一个栈帧，
    // 对拿到产物的玩家毫无意义——产物通常不是作者本人在玩。
    document.body.innerHTML =
      '<div class="iforge-boot-error" role="alert">' +
      '打包产物缺少 <code>window.__IFORGE_BOOTSTRAP__</code>：项目数据未注入。' +
      '请重新用编辑器导出该游戏（11.1 的模板注入步骤）。' +
      '</div>'
    return
  }

  let element = document.getElementById(ROOT_ID)
  if (!element) {
    element = document.createElement('div')
    element.id = ROOT_ID
    document.body.append(element)
  }

  mountGameRuntime({
    element,
    bootstrap: raw as Bootstrap,
    projectId: raw.meta?.fingerprint ? `pkg-${raw.meta.fingerprint.slice(0, 12)}` : undefined,
    slotId: raw.meta?.slotId ?? 'main',
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true })
} else {
  bootstrap()
}
