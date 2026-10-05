/**
 * 顶部标题栏（PRD 工作页面一览「顶部标题栏」、TECH_DESIGN 7.1 表）。
 *
 * 左：应用图标 + 产品标题；中：项目名称（未保存时带圆点标记）；右：新建、保存、导入、导出、
 * 撤销/重做、打包。
 *
 * “打包”按钮仅在 `game:ready` 后启用（7.1 表 + 9.3 生命周期第 2 步）；未就绪时置灰并在悬浮提示里
 * 说明原因，而不是给一个点了没反应的按钮。
 *
 * ## 为什么每个按钮都带 `data-testid`
 *
 * 按钮的可访问名里有中文文案（“新建”“保存”…），而**同一个词**在别处也会出现
 * （`NumExprField` 里也有一个 `aria-label="撤销"` 的回退图标按钮，表单区与标题栏重名）。
 * 按角色+文案定位会撞上 strict mode violation。用 `data-testid` 定位是这里的既定做法
 * （`App.tsx` 的确认按钮、`PreviewPane` 的模拟设置栏都是这样），不引入第二套约定。
 */
import { t } from '@iforge/i18n'

import { Icon } from '../components/Icon.js'
import { useHistoryStore } from '../stores/history.js'
import { usePreviewStore } from '../stores/preview.js'
import { useProjectStore } from '../stores/project.js'

export interface TitleBarProps {
  onNew(): void
  onSave(): void
  onImport(): void
  onExport(): void
  onUndo(): void
  onRedo(): void
  onPackage(): void
}

export function TitleBar({ onNew, onSave, onImport, onExport, onUndo, onRedo, onPackage }: TitleBarProps) {
  const projectName = useProjectStore((state) => state.project.meta.name)
  const dirty = useProjectStore((state) => state.dirty)
  const ready = usePreviewStore((state) => state.status === 'ready')
  // 撤销/重做的可用性随历史栈变化：**两个长度分别订阅**。
  //
  // 写成 `past.length + future.length` 会漏掉“撤销一步”这种变化——撤销时 past 减 1、
  // future 加 1，和恰好不变，订阅值没变就不重渲染，按钮会一直停在撤销前的置灰状态
  // （状态是对的、按钮是旧的）。因此这里必须订阅两个**原始数字**：
  // 既不会像返回新对象那样每次比较都不相等（见 `SideNav.tsx` 的注释），也不会漏变化。
  const pastLength = useHistoryStore((state) => state.past.length)
  const futureLength = useHistoryStore((state) => state.future.length)
  const undoEnabled = pastLength > 0
  const redoEnabled = futureLength > 0

  return (
    <header className="title-bar">
      <div className="title-bar-brand">
        <Icon builtinId="iforge-logo" size={22} />
        <span className="title-bar-title">{t('app.title')}</span>
      </div>
      <div className="title-bar-project" title={t('titleBar.projectName')}>
        <span>{projectName}</span>
        {dirty ? <span className="dirty-dot" title={t('titleBar.unsaved')} aria-label={t('titleBar.unsaved')} /> : null}
      </div>
      <div className="title-bar-actions">
        <button type="button" className="btn" data-testid="titlebar-new" onClick={onNew} aria-keyshortcuts="Control+N">
          {t('titleBar.new')}
        </button>
        <button type="button" className="btn" data-testid="titlebar-save" onClick={onSave} aria-keyshortcuts="Control+S">
          {t('titleBar.save')}
        </button>
        <button type="button" className="btn" data-testid="titlebar-import" onClick={onImport} aria-keyshortcuts="Control+O">
          {t('titleBar.import')}
        </button>
        <button type="button" className="btn" data-testid="titlebar-export" onClick={onExport} aria-keyshortcuts="Control+E">
          {t('titleBar.export')}
        </button>
        <button
          type="button"
          className="btn"
          data-testid="titlebar-undo"
          onClick={onUndo}
          disabled={!undoEnabled}
          aria-keyshortcuts="Control+Z"
          aria-label={t('titleBar.undo')}
          title={`${t('titleBar.undo')}（Ctrl+Z）`}
        >
          <Icon builtinId="undo" size={14} />
        </button>
        <button
          type="button"
          className="btn"
          data-testid="titlebar-redo"
          onClick={onRedo}
          disabled={!redoEnabled}
          aria-keyshortcuts="Control+Y"
          aria-label={t('titleBar.redo')}
          title={`${t('titleBar.redo')}（Ctrl+Y）`}
        >
          <Icon builtinId="redo" size={14} />
        </button>
        <button
          type="button"
          className="btn"
          data-testid="titlebar-package"
          onClick={onPackage}
          disabled={!ready}
          aria-keyshortcuts="Control+P"
          title={ready ? t('titleBar.package') : t('lifecycle.packageNotReady')}
        >
          <Icon builtinId="package" size={14} /> {t('titleBar.package')}
        </button>
      </div>
    </header>
  )
}
