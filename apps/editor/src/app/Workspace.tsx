/**
 * 中间工作区（PRD 工作页面一览「中间工作区」、TECH_DESIGN 7.1/7.6）。
 *
 * 内容随左侧功能区变化：四类工作区 + 设置页面。
 *
 * **切换功能区时不丢输入**（7.1 表：未提交的文本按 400ms 合并窗口提交为一次事务）：
 * 表单字段的每次修改都**立即**进事务（合并窗口作用于撤销粒度），因此切换时不存在
 * “未提交文本”这种中间态——这条要求由 `commitField(..., mergeKey)` 落实，而不是额外维护草稿。
 */
import { t } from '@iforge/i18n'

import { GeneratorWorkspace } from '../features/generators/GeneratorWorkspace.js'
import { PageWorkspace } from '../features/pages/PageWorkspace.js'
import { ResourceWorkspace } from '../features/resources/ResourceWorkspace.js'
import { SettingsPage } from '../features/settings/SettingsPage.js'
import { UpgradeWorkspace } from '../features/upgrades/UpgradeWorkspace.js'
import { useEditorStore } from '../stores/editor.js'
import { useProjectStore } from '../stores/project.js'

export function Workspace() {
  const section = useEditorStore((state) => state.activeSection)
  const project = useProjectStore((state) => state.project)
  const selection = useEditorStore((state) => state.selection)
  const select = useEditorStore((state) => state.select)

  switch (section) {
    case 'resources':
      return <ResourceWorkspace project={project} selectedId={selection.resource} onSelect={(id) => select('resource', id)} />
    case 'generators':
      return <GeneratorWorkspace project={project} selectedId={selection.generator} onSelect={(id) => select('generator', id)} />
    case 'upgrades':
      return <UpgradeWorkspace project={project} selectedId={selection.upgrade} onSelect={(id) => select('upgrade', id)} />
    case 'pages':
      return <PageWorkspace project={project} selectedId={selection.page} onSelect={(id) => select('page', id)} />
    case 'settings':
      return (
        <div className="workspace settings">
          <div className="workspace-form">
            <SettingsPage project={project} />
          </div>
        </div>
      )
    default:
      return <p className="muted pad">{t('list.empty')}</p>
  }
}
