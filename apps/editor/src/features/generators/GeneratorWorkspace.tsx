/**
 * 生成器工作区（TECH_DESIGN 7.6「生成器：`GeneratorList` + `GeneratorForm`」、PRD 生成器编辑器 1–11）。
 *
 * 表单覆盖 PRD 的 11 个字段，重点交互：
 * - **批量购买三态**（PRD 生成器 8）：`BatchBuyEditor` 的三档分段控件（8.6 表）；
 * - **点击器**（PRD 生成器 11）：开启时隐藏自动生产相关项并提示（D-19/D-28：
 *   点击器取消自动生产、不可购买、初始数量只作拥有数量）；
 * - **成本/产出双列表**（PRD 生成器 9/10）：增删行 + 拖拽排序 + 引用选择器；
 *   购买材料**只能选资源**，产出可指向资源或生成器（6.4 引用完整性）；
 * - **单件产出速率**（D-30）：字段旁常驻提示“总产出 = 拥有数量 × Σ 速率（只乘一次）”，
 *   否则作者极易把速率写成已乘过 owned 的表达式，导致 `owned²`（R-26）。
 */
import { t } from '@iforge/i18n'
import type { CostEntry, GeneratorDef, ProjectFile } from '@iforge/model'

import { BatchBuyEditor } from '../../components/BatchBuyEditor.js'
import { EntryList } from '../../components/EntryList.js'
import { IconPicker } from '../../components/IconPicker.js'
import { NumExprField } from '../../components/NumExprField.js'
import { RefPicker } from '../../components/RefPicker.js'
import { NumberField, TextAreaField, TextField, ToggleField } from '../../components/fields.js'
import { commitField } from '../../stores/form.js'
import { addEntry, duplicateEntry, moveEntry } from '../../stores/entries.js'
import { requestDeleteFor } from '../shell/deleteFlow.js'

/** 自动最大购买的间隔选项（D-04：1/5/10/50 tick）。 */
const BUY_DELAY_OPTIONS = [1, 5, 10, 50]

/** 生成器表单（PRD 生成器编辑器 1–11）。 */
export function GeneratorForm({ generator, project }: { generator: GeneratorDef; project: ProjectFile }) {
  const id = generator.id
  const commit = (label: string, recipe: Parameters<typeof commitField>[3], mergeKey?: string): void =>
    commitField('generator', id, label, recipe, mergeKey)

  const setRow = (rows: 'costs' | 'produces', index: number, patch: Partial<CostEntry>): void =>
    commit(
      `gen-${rows}`,
      (draft) => {
        const def = draft as GeneratorDef
        const row = def[rows][index]
        if (!row) return
        Object.assign(row, patch)
      },
      `${id}.${rows}[${index}]`,
    )

  const addRow = (rows: 'costs' | 'produces'): void =>
    commit(`gen-add-${rows}`, (draft) => {
      const def = draft as GeneratorDef
      def[rows] = [...def[rows], { materialId: '', amount: '1' }]
    })

  const removeRow = (rows: 'costs' | 'produces', index: number): void =>
    commit(`gen-remove-${rows}`, (draft) => {
      const def = draft as GeneratorDef
      def[rows] = def[rows].filter((_, i) => i !== index)
    })

  const moveRow = (rows: 'costs' | 'produces', index: number, direction: -1 | 1): void =>
    commit(`gen-move-${rows}`, (draft) => {
      const def = draft as GeneratorDef
      const next = [...def[rows]]
      const target = index + direction
      if (target < 0 || target >= next.length) return
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved!)
      def[rows] = next
    })

  return (
    <div className="form" data-testid="generator-form">
      <IconPicker
        value={generator.icon}
        onChange={(icon) => commit('gen-icon', (d) => void ((d as GeneratorDef).icon = icon))}
        groups={['generator', 'clicker', 'system']}
      />
      <TextField
        label={t('field.name')}
        value={generator.name}
        onChange={(name) => commit('gen-name', (d) => void ((d as GeneratorDef).name = name), `${id}.name`)}
      />
      <TextAreaField
        label={t('field.description')}
        value={generator.description}
        onChange={(description) => commit('gen-desc', (d) => void ((d as GeneratorDef).description = description), `${id}.description`)}
      />
      <NumExprField
        label={t('field.initial')}
        value={generator.initial}
        context="field"
        hint={generator.isClicker ? t('generator.clickerHint') : undefined}
        snippetBase={`gen.${id}`}
        onChange={(initial) => commit('gen-initial', (d) => void ((d as GeneratorDef).initial = initial), `${id}.initial`)}
      />
      <NumExprField
        label={t('field.max')}
        value={generator.max}
        context="field"
        snippetBase={`gen.${id}`}
        onChange={(max) => commit('gen-max', (d) => void ((d as GeneratorDef).max = max), `${id}.max`)}
      />
      <ToggleField
        label={t('field.isClicker')}
        value={generator.isClicker}
        hint={t('generator.clickerHint')}
        onChange={(isClicker) => commit('gen-clicker', (d) => void ((d as GeneratorDef).isClicker = isClicker))}
      />
      <ToggleField
        label={t('field.visible')}
        value={generator.visible}
        onChange={(visible) => commit('gen-visible', (d) => void ((d as GeneratorDef).visible = visible))}
      />
      <ToggleField
        label={t('field.disabled')}
        value={generator.disabled}
        onChange={(disabled) => commit('gen-disabled', (d) => void ((d as GeneratorDef).disabled = disabled))}
      />

      <BatchBuyEditor
        value={generator.buyAmount}
        pathPrefix={`gen.${id}`}
        disabled={generator.isClicker}
        onChange={(buyAmount) => commit('gen-buyAmount', (d) => void ((d as GeneratorDef).buyAmount = buyAmount), `${id}.buyAmount`)}
      />
      <NumberField
        label={t('generator.buyDelay')}
        value={generator.buyDelay}
        min={1}
        step={1}
        hint="自动最大购买每隔 N tick 尝试一次（默认每 tick），离线不触发（D-04）。"
        onChange={(buyDelay) => commit('gen-buyDelay', (d) => void ((d as GeneratorDef).buyDelay = Math.max(1, Math.round(buyDelay))))}
      />
      <div className="chips" role="group" aria-label={t('generator.buyDelay')}>
        {BUY_DELAY_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className={generator.buyDelay === option ? 'chip active' : 'chip'}
            aria-pressed={generator.buyDelay === option}
            onClick={() => commit('gen-buyDelay', (d) => void ((d as GeneratorDef).buyDelay = option))}
          >
            {option} {t('field.ticks')}
          </button>
        ))}
      </div>

      <section className="form-section">
        <h3>{t('field.costs')}</h3>
        <p className="muted">{t('generator.costsHint')}</p>
        {generator.costs.map((row, index) => (
          <div className="row-editor" key={`cost-${index}`}>
            <RefPicker
              label={`${t('field.costs')} ${index + 1} · ${t('field.materialId')}`}
              value={row.materialId}
              allowed={['resource']}
              project={project}
              onChange={(materialId) => setRow('costs', index, { materialId })}
            />
            <NumExprField
              label={`${t('field.costs')} ${index + 1} · ${t('field.amount')}`}
              value={row.amount}
              context="price"
              snippetBase={`gen.${id}`}
              onChange={(amount) => setRow('costs', index, { amount })}
            />
            <RowButtons index={index} count={generator.costs.length} onMove={moveRow.bind(null, 'costs')} onRemove={removeRow.bind(null, 'costs')} />
          </div>
        ))}
        <button type="button" className="btn" onClick={() => addRow('costs')}>
          + {t('field.costs')}
        </button>
      </section>

      <section className="form-section">
        <h3>{t('field.produces')}</h3>
        <p className="muted">{t('generator.producesHint')}</p>
        {generator.produces.map((row, index) => (
          <div className="row-editor" key={`produce-${index}`}>
            <RefPicker
              label={`${t('field.produces')} ${index + 1} · ${t('field.materialId')}`}
              value={row.materialId}
              allowed={['resource', 'generator']}
              project={project}
              onChange={(materialId) => setRow('produces', index, { materialId })}
            />
            <NumExprField
              label={`${t('field.produces')} ${index + 1} · ${t('field.amount')}`}
              value={row.amount}
              context="production"
              snippetBase={`gen.${id}`}
              onChange={(amount) => setRow('produces', index, { amount })}
            />
            <RowButtons
              index={index}
              count={generator.produces.length}
              onMove={moveRow.bind(null, 'produces')}
              onRemove={removeRow.bind(null, 'produces')}
            />
          </div>
        ))}
        <button type="button" className="btn" onClick={() => addRow('produces')}>
          + {t('field.produces')}
        </button>
      </section>

      <p className="muted">{`gen.${id}.owned / gen.${id}.bought（只读）`}</p>
    </div>
  )
}

/** 列表行的上移/下移/删除（成本与产出共用）。 */
function RowButtons(props: { index: number; count: number; onMove(index: number, direction: -1 | 1): void; onRemove(index: number): void }) {
  const { index, count, onMove, onRemove } = props
  return (
    <div className="row-actions">
      <button type="button" className="icon-btn" aria-label={t('common.moveUp')} disabled={index === 0} onClick={() => onMove(index, -1)}>
        ↑
      </button>
      <button type="button" className="icon-btn" aria-label={t('common.moveDown')} disabled={index === count - 1} onClick={() => onMove(index, 1)}>
        ↓
      </button>
      <button type="button" className="icon-btn danger" aria-label={t('common.remove')} onClick={() => onRemove(index)}>
        ✕
      </button>
    </div>
  )
}

/** 生成器工作区（7.6）。 */
export function GeneratorWorkspace(props: { project: ProjectFile; selectedId: string | null; onSelect(id: string): void }) {
  const { project, selectedId, onSelect } = props
  const selected = project.generators.find((item) => item.id === selectedId) ?? null
  return (
    <div className="workspace">
      <EntryList
        kind="generator"
        title={t('list.generators')}
        items={project.generators}
        selectedId={selectedId}
        onSelect={onSelect}
        onAdd={() => addEntry('generator')}
        onMove={(id, direction) => moveEntry('generator', id, direction)}
        onDuplicate={(id) => duplicateEntry('generator', id)}
        onDelete={(id) => requestDeleteFor('generator', id)}
      />
      <div className="workspace-form">
        {selected ? <GeneratorForm generator={selected} project={project} /> : <p className="muted pad">{t('list.empty')}</p>}
      </div>
    </div>
  )
}
