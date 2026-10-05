/**
 * 游戏视图的主题解析（TECH_DESIGN 7.8、17.4、PRD 页面编辑器 6/8、`build/template.ts` 的主题约定）。
 *
 * ## 两个命名空间，两个注入点
 *
 * | 命名空间 | 注入点 | 由谁解析 |
 * | --- | --- | --- |
 * | `--iforge-page-*` | **根节点** `.game-root` | 当前页面的 `PageDef.theme`（`AppView`） |
 * | `--iforge-entry-*` | 条目网格容器 `.entry-grid` | `PageDef.entries[i].theme`（`PageView`） |
 *
 * ## 为什么页面主题必须落在**根节点**而不是页面节
 *
 * 页面主题表达的是“这一页长什么样”，而顶部标题栏、数据仪表盘、底部导航栏与内置设置页
 * 是这条页面不可分割的一部分：它们都是 `.game-root` 的直接子节点，**不是** `.game-page`
 * 的后代。令牌只内联到 `.game-page` 时它们读不到（`game.css` 里那些壳层规则读的是
 * `--iforge-page-*`），于是作者把页面换成 `page-light` 得到的是“上面一栏深色、
 * 下面一片浅色”的割裂界面——换页面主题对壳层零影响。
 *
 * 落在根节点上还有两个附带好处：切页时壳层跟着换色（8.12 的 `nav()` 只改
 * `currentPageId`，主题随之由视图重算），以及内置设置页（没有 `PageDef.theme`）
 * 自然落到 `DEFAULT_THEME.page` 的缺省值。
 *
 * 17.3 的模板注释也是这么写的：“页面主题与条目主题由 `AppView` 在运行期
 * 按 `PageDef.theme` / `entries[i].theme` 施加到**根节点**”。
 *
 * ## 为什么还要一份落在 `documentElement` 上
 *
 * `.game-root` **不是**文档的根：`body`（`.iforge-game`）才是，而它自己的
 * `background: var(--iforge-page-bg)` 在 **body 自己的作用域**里解析变量——
 * 那里只有 `.iforge-game` 声明的缺省值 `#14161c`（永远是暗色），拿不到写在
 * 子节点上的内联令牌。于是只要主题换成浅色，`body` 仍是暗色：页面本体、仪表盘、
 * 底部导航都白了，唯独根节点 8px 内边距那一圈、以及任何**溢出 `.game-root` 盒子**
 * 的区域（条目过多时仪表盘把壳层顶出视口）露出一圈黑边。
 *
 * `html` 的画布同理：17.3 的模板给 `html,body` 写死了 `background:#14161a`，
 * 而 `html` 一旦有背景，`body` 的背景就**不再向画布传播**（CSS 背景传播规则），
 * 于是 body 盒子之外的任何区域都是那个写死的暗色。
 *
 * 因此把同一份令牌再写到**两处**文档外壳：
 *
 * | 写入点 | 谁读它 | 为什么必须是它 |
 * | --- | --- | --- |
 * | `document.documentElement` | 17.3 模板里的 `html,body{background:var(--iforge-page-bg,…)}` | `html` 有背景时 `body` 的背景**不再向画布传播**，画布因此由 `html` 决定；`html` 是根，往它身上写令牌是唯一能影响画布的办法 |
 * | `document.body`（`.iforge-game`） | `game.css` 里 `.iforge-game{background:var(--iforge-page-bg)}` | `body` **自己**声明了 `--iforge-page-*` 的缺省值（永远是暗色），因此从 `html` **继承**来的同名令牌会被它自己的声明盖住；行内样式是同元素上优先级最高的，才压得住 |
 *
 * 少写任何一处都会留下黑边：只写根节点时 `body` 读到的是自己的暗色缺省值，
 * 只写 `body` 时画布（超出 body 盒子的区域）仍是模板里的暗色。
 * 模板里的 `var(--iforge-page-bg, #14161a)` 兜底值保证脚本执行前仍是一份合理的暗色。
 */
import { useLayoutEffect, useMemo } from 'react'
import type { CSSProperties } from 'react'

import type { ThemeRef } from '@iforge/model'
import { TOKEN_KEYS, TOKEN_PREFIX, resolveEntryTokens, resolveThemeTokens } from '@iforge/ui-kit'
import type { TokenScope, TokenSet } from '@iforge/ui-kit'

/**
 * `view-model` 的主题引用文本（`kind:value`）-> `ThemeRef`；无法识别时按缺省处理。
 *
 * 拆第一个冒号即可：`themeKeyOf` 拼的就是 `${kind}:${value}`，而 `value` 本身可能含冒号
 * （`data:` 后面就是一段 CSS），因此**不能**按最后一个冒号切。
 */
export function themeRefOf(key: string | undefined): ThemeRef | undefined {
  if (!key) return undefined
  const at = key.indexOf(':')
  if (at <= 0) return undefined
  const kind = key.slice(0, at)
  if (kind !== 'builtin' && kind !== 'asset' && kind !== 'data') return undefined
  return { kind, value: key.slice(at + 1) } as ThemeRef
}

/**
 * 令牌集 -> 行内 CSS 变量（React 的 `style` 只接受驼峰或 `--` 自定义属性）。
 *
 * 放在**渲染期**解析（而不是写进项目文件或存档）有两个理由：
 * 缺项按 `completeTokens` 逐键回退（D-13），且主题改动只需重渲染、不必回写任何数据。
 */
export function tokenStyle(tokens: TokenSet, scope: TokenScope): CSSProperties {
  const prefix = TOKEN_PREFIX[scope]
  const style: Record<string, string> = {}
  for (const key of TOKEN_KEYS) style[`${prefix}${key}`] = tokens[key]
  return style as CSSProperties
}

/** 页面主题令牌（`--iforge-page-*`）。缺省按 17.4 的 `page-dark`（D-13）。 */
export function pageTokenStyle(theme: ThemeRef | undefined): CSSProperties {
  return tokenStyle(resolveThemeTokens(theme, 'page'), 'page')
}

/**
 * 把页面主题令牌施加到文档外壳的两处（文件头那张表的最后两行）。
 *
 * `useLayoutEffect` 而不是 `useEffect`：后者在浏览器绘制之后才跑，浅色主题下会
 * 先闪一帧暗色底。布局期副作用与本次渲染同批提交，闪帧从“肉眼可见”降到“无”。
 *
 * 卸载时逐键清掉自己写过的属性：单测里同一 jsdom 文档会挂载/卸载多棵组件树，
 * 残留的令牌会让下一条用例读到上一个项目的主题（症状是“测试之间互相污染”，
 * 而失败点离原因很远）。
 */
export function useDocumentPageTokens(theme: ThemeRef | undefined): void {
  // 依赖**解析后的令牌**而不是 `theme` 对象：`themeRefOf` 每次渲染都产出新对象，
  // 拿它当依赖会让这个副作用每帧重跑（把令牌逐键写两遍）。
  const kind = theme?.kind
  const value = theme?.value
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `kind`/`value` 就是 theme 的全部内容
  const tokens = useMemo(() => resolveThemeTokens(theme, 'page'), [kind, value])
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    const targets = [document.documentElement, document.body]
    for (const key of TOKEN_KEYS) {
      for (const target of targets) target.style.setProperty(`${TOKEN_PREFIX.page}${key}`, tokens[key])
    }
    return () => {
      for (const key of TOKEN_KEYS) {
        for (const target of targets) target.style.removeProperty(`${TOKEN_PREFIX.page}${key}`)
      }
    }
  }, [tokens])
}

/** 条目主题令牌（`--iforge-entry-*`）；未指定条目主题时跟随页面主题（PRD 页面编辑器 8）。 */
export function entryTokenStyle(pageTheme: ThemeRef | undefined, entryTheme: ThemeRef | undefined): CSSProperties {
  return tokenStyle(resolveEntryTokens(pageTheme, entryTheme), 'entry')
}
