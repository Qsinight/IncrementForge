/**
 * 资源工作区（TECH_DESIGN 7.6「资源：`ResourceList` + `ResourceForm`」、PRD 资源编辑器 1–6）。
 *
 * 表单字段与 6.5.1 的映射逐条对应：图标 / 名称 / 描述 / 初始数量 / 数量上限 / 游戏可见。
 *
 * - **名称改后立即同步列表与预览**（PRD 资源编辑器 2）：表单直接写 `projectStore`，
 *   列表与标题栏订阅同一份状态，因此不存在“表单改了列表没变”的可能；
 * - **数量上限必定大于零**（PRD 资源编辑器 5）：这里给红框提示；运行期的“≤ 0 按 1 处理 + 诊断”
 *   由 4.4 第 4 条负责（编辑器不擅自改写作者的表达式）。
 */
import { t } from '@iforge/i18n'
import { NO_LIMIT } from '@iforge/model'
import type { ProjectFile, ResourceDef } from '@iforge/model'

import { EntryList } from '../../components/EntryList.js'
import { IconPicker } from '../../components/IconPicker.js'
import { NumExprField } from '../../components/NumExprField.js'
import { TextAreaField, TextField, ToggleField } from '../../components/fields.js'
import { addEntry, duplicateEntry, moveEntry } from '../../stores/entries.js'
import { commitField } from '../../stores/form.js'
import { requestDeleteFor } from '../shell/deleteFlow.js'

/** 资源表单（PRD 资源编辑器 1–6）。 */
export function ResourceForm({ resource, project }: { resource: ResourceDef; project: ProjectFile }) {
  const commit = (label: string, recipe: Parameters<typeof commitField>[3], mergeKey?: string): void =>
    commitField('resource', resource.id, label, recipe, mergeKey)
  return (
    <div className="form" data-testid="resource-form">
      <IconPicker value={resource.icon} onChange={(icon) => commit('res-icon', (d) => void (d.icon = icon))} groups={['resource', 'system']} />
      <TextField
        label={t('field.name')}
        value={resource.name}
        onChange={(name) => commit('res-name', (d) => void (d.name = name), `${resource.id}.name`)}
      />
      <TextAreaField
        label={t('field.description')}
        value={resource.description}
        onChange={(description) => commit('res-desc', (d) => void (d.description = description), `${resource.id}.description`)}
      />
      <NumExprField
        label={t('field.initial')}
        value={resource.initial}
        context="field"
        snippetBase={`res.${resource.id}`}
        onChange={(initial) => commit('res-initial', (d) => void (d.initial = initial), `${resource.id}.initial`)}
      />
      <NumExprField
        label={t('field.max')}
        value={resource.max}
        context="field"
        hint={t('resource.maxHint')}
        snippetBase={`res.${resource.id}`}
        onChange={(max) => commit('res-max', (d) => void (d.max = max), `${resource.id}.max`)}
      />
      <ToggleField
        label={t('field.visible')}
        value={resource.visible}
        hint={t('resource.visibleHint')}
        onChange={(visible) => commit('res-visible', (d) => void (d.visible = visible))}
      />
      <p className="muted">
        {t('field.max')}：<code>{NO_LIMIT}</code> = 无上限（D-46）；资源无 {t('field.disabled')} 与 bought（D-20、D-37）。
      </p>
      <pre className="path-preview">{`res.${resource.id}.amount / res.${resource.id}.owned`}</pre>
      <span className="muted">{project.resources.length} 个资源</span>
    </div>
  )
}

/** 资源工作区：左侧列表 + 中间表单（7.6）。 */
export function ResourceWorkspace({
  project,
  selectedId,
  onSelect,
}: {
  project: ProjectFile
  selectedId: string | null
  onSelect(id: string): void
}) {
  const selected = project.resources.find((item) => item.id === selectedId) ?? null
  return (
    <div className="workspace">
      <EntryList
        kind="resource"
        title={t('list.resources')}
        items={project.resources}
        selectedId={selectedId}
        onSelect={onSelect}
        onAdd={() => addEntry('resource')}
        onMove={(id, direction) => moveEntry('resource', id, direction)}
        onDuplicate={(id) => duplicateEntry('resource', id)}
        onDelete={(id) => requestDeleteFor('resource', id)}
      />
      <div className="workspace-form">
        {selected ? <ResourceForm resource={selected} project={project} /> : <p className="muted pad">{t('list.empty')}</p>}
      </div>
    </div>
  )
}
