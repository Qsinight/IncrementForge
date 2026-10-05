/**
 * 底部导航（PRD 预览区 8、8.12）。
 *
 * ## 三个易错点
 *
 * 1. **最后一格固定是内置设置页**（8.11/8.12）：它不是 `PageDef`、不进 `pages`、不参与
 *    可见/禁用继承，用哨兵 `'__settings__'` 表示。`view-model.buildNav()` 已经把它拼在
 *    数组末尾并打上 `builtIn`，这里只渲染。
 * 2. **页面禁用不隐藏按钮**（PRD 页面编辑器 4「仍可跳转」）：只过滤 `visible === false`
 *    （8.12「不可见页面不渲染按钮，但可直接通过 `nav(pageId)` 到达」）。过滤在
 *    `buildNav()` 里，组件无条件渲染它给出的列表。
 * 3. **点击一律走 `nav()`**（8.12「入口收敛」）：组件不直接写 `currentPageId`，
 *    否则会出现绕过 8.4 判定的跳转路径。
 */
import type { NavItemView } from '@iforge/runtime'
import { t } from '@iforge/i18n'

import { Icon } from './Icon.js'

export interface BottomNavProps {
  items: NavItemView[]
  onNavigate(pageId: string): void
  /** 透传给根元素的 `data-testid`（PRD 预览区 8；E2E 用它断言导航存在）。 */
  testId?: string
}

export function BottomNav({ items, onNavigate, testId }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label={t('game.nav')} data-testid={testId}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.current ? 'nav-item current' : 'nav-item'}
          data-testid="nav-item"
          data-page-id={item.id}
          data-built-in={item.builtIn ? 'true' : 'false'}
          aria-current={item.current ? 'page' : undefined}
          onClick={() => onNavigate(item.id)}
        >
          <Icon icon={item.icon.startsWith('builtin:') ? item.icon : `builtin:${item.icon}`} alt={item.name} className="nav-icon" />
          <span className="nav-name">{item.name}</span>
        </button>
      ))}
    </nav>
  )
}
