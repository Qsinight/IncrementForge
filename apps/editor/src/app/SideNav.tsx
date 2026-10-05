/**
 * 左侧功能区（PRD 工作页面一览「左侧功能区」、TECH_DESIGN 7.1 表）。
 *
 * 自上而下：资源 / 生成器 / 升级 / 页面 / 设置。
 *
 * **当前功能区不进历史栈**（D-14：撤销/重做只覆盖项目数据），
 * 切换也不触碰项目数据与预览（7.1 表“实现要点”列）。
 * 窄屏折叠为图标栏由 CSS 处理（同一份 DOM，不做第二套渲染逻辑，与 9.1 的断点策略一致）。
 */
import { t } from '@iforge/i18n'

import { Icon } from '../components/Icon.js'
import { SECTIONS, useEditorStore } from '../stores/editor.js'
import type { SectionId } from '../stores/editor.js'
import { useProjectStore } from '../stores/project.js'

/** 功能区 -> 图标（17.4 的内置图标分组）。 */
const SECTION_ICON: Readonly<Record<SectionId, string>> = {
  resources: 'gem',
  generators: 'factory',
  upgrades: 'star',
  pages: 'grid',
  settings: 'gear',
}

/** 功能区 -> 文案 key（PRD 四类列表名 + 设置）。 */
const SECTION_LABEL: Readonly<Record<SectionId, string>> = {
  resources: 'sideNav.resources',
  generators: 'sideNav.generators',
  upgrades: 'sideNav.upgrades',
  pages: 'sideNav.pages',
  settings: 'sideNav.settings',
}

export function SideNav() {
  const active = useEditorStore((state) => state.activeSection)
  const setSection = useEditorStore((state) => state.setSection)
  // 计数逐项订阅：选择器返回**原始数字**。若返回 `{…}` 新对象，zustand v5 的
  // `useSyncExternalStore` 每次比较都不相等 -> 无限重渲染（React 报 “Maximum update depth exceeded”）。
  const resourceCount = useProjectStore((state) => state.project.resources.length)
  const generatorCount = useProjectStore((state) => state.project.generators.length)
  const upgradeCount = useProjectStore((state) => state.project.upgrades.length)
  const pageCount = useProjectStore((state) => state.project.pages.length)
  const counts: Partial<Record<SectionId, number>> = {
    resources: resourceCount,
    generators: generatorCount,
    upgrades: upgradeCount,
    pages: pageCount,
  }

  return (
    <nav className="side-nav" aria-label={t('app.title')}>
      <ul>
        {SECTIONS.map((section) => (
          <li key={section}>
            <button
              type="button"
              className={active === section ? 'side-nav-item active' : 'side-nav-item'}
              aria-current={active === section}
              onClick={() => setSection(section)}
              data-testid={`nav-${section}`}
            >
              <Icon builtinId={SECTION_ICON[section]} size={16} />
              <span className="side-nav-label">{t(SECTION_LABEL[section])}</span>
              {section in counts ? <span className="side-nav-count">{counts[section]}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
