/**
 * 升级工作区（TECH_DESIGN 7.6「升级：`UpgradeList` + `UpgradeForm`」、PRD 升级编辑器 1–12、D-47）。
 *
 * ## “效果数值”列是只读的（7.6 末条 + D-47）
 *
 * PRD 升级编辑器 12 说效果数值是“空白数字变量，默认为零，**由用户自行赋值**”。
 * 本设计把“由用户自行赋值”的落点定为**运行时表达式赋值**（`action` 内的 `effValue` 或
 * `up.<id>.effectValues[i]`），而不是编辑器输入框——输入框会把它变成项目文件里的设计期常量，
 * 与 PRD 补充 6（运行时赋值只写存档、不写项目文件）冲突。
 *
 * 因此 7.6 要求的三项强制 UI 元素在这里全部落地：
 * 1. **只读徽标**（`upgrade.effectValue.readonly`）+ 悬浮说明；
 * 2. **无运行态时的 `0` 占位**（来自影子运行时的当前值，没有则显示 0）；
 * 3. **两条快捷插入模板**（`effValue = <表达式>` / `up.<id>.effectValues[i] = <表达式>`）一键写入“效果内容”。
 *
 * 另外提示：条件/效果字段旁常驻 [5.9.3 的“可做/不可做”对照](D-29)——
 * 赋值写入的是**求值后的常量文本**，换表达式要用字符串字面量 `set("路径", "源码")`。
 */
import { t } from '@iforge/i18n'
import type { EffectEntry, ProjectFile, UpgradeDef } from '@iforge/model'

import { BatchBuyEditor } from '../../components/BatchBuyEditor.js'
import { EntryList } from '../../components/EntryList.js'
import { IconPicker } from '../../components/IconPicker.js'
import { NumExprField } from '../../components/NumExprField.js'
import { RefPicker } from '../../components/RefPicker.js'
import { TextAreaField, TextField, ToggleField } from '../../components/fields.js'
import { addEntry, duplicateEntry, moveEntry } from '../../stores/entries.js'
import { commitField } from '../../stores/form.js'
import { useShadow } from '../../stores/shadowStore.js'
import { requestDeleteFor } from '../shell/deleteFlow.js'

/** 升级表单（PRD 升级编辑器 1–12）。 */
export function UpgradeForm({ upgrade, project }: { upgrade: UpgradeDef; project: ProjectFile }) {
  const id = upgrade.id
  const effectValues = useShadow().effectValuesOf(id)
  const commit = (label: string, recipe: Parameters<typeof commitField>[3], mergeKey?: string): void =>
    commitField('upgrade', id, label, recipe, mergeKey)

  const setEffect = (index: number, patch: Partial<EffectEntry>): void =>
    commit(
      'up-effect',
      (draft) => {
        const def = draft as UpgradeDef
        const effect = def.effects[index]
        if (!effect) return
        Object.assign(effect, patch)
      },
      `${id}.effects[${index}]`,
    )

  const addEffect = (): void =>
    commit('up-add-effect', (draft) => {
      const def = draft as UpgradeDef
      def.effects = [...def.effects, { condition: 'true', action: 'effValue = 0' }]
    })

  const removeEffect = (index: number): void =>
    commit('up-remove-effect', (draft) => {
      const def = draft as UpgradeDef
      def.effects = def.effects.filter((_, i) => i !== index)
    })

  return (
    <div className="form" data-testid="upgrade-form">
      <IconPicker
        value={upgrade.icon}
        onChange={(icon) => commit('up-icon', (d) => void ((d as UpgradeDef).icon = icon))}
        groups={['upgrade', 'system']}
      />
      <TextField
        label={t('field.name')}
        value={upgrade.name}
        onChange={(name) => commit('up-name', (d) => void ((d as UpgradeDef).name = name), `${id}.name`)}
      />
      <TextAreaField
        label={t('field.description')}
        value={upgrade.description}
        onChange={(description) => commit('up-desc', (d) => void ((d as UpgradeDef).description = description), `${id}.description`)}
      />
      <NumExprField
        label={t('field.initial')}
        value={upgrade.initial}
        context="field"
        snippetBase={`up.${id}`}
        onChange={(initial) => commit('up-initial', (d) => void ((d as UpgradeDef).initial = initial), `${id}.initial`)}
      />
      <NumExprField
        label={t('field.max')}
        value={upgrade.max}
        context="field"
        snippetBase={`up.${id}`}
        onChange={(max) => commit('up-max', (d) => void ((d as UpgradeDef).max = max), `${id}.max`)}
      />
      <ToggleField
        label={t('field.visible')}
        value={upgrade.visible}
        onChange={(visible) => commit('up-visible', (d) => void ((d as UpgradeDef).visible = visible))}
      />
      <ToggleField
        label={t('field.disabled')}
        value={upgrade.disabled}
        onChange={(disabled) => commit('up-disabled', (d) => void ((d as UpgradeDef).disabled = disabled))}
      />
      <ToggleField
        label={t('field.perSecond')}
        value={upgrade.perSecond}
        hint={t('upgrade.perSecondHint')}
        onChange={(perSecond) => commit('up-persecond', (d) => void ((d as UpgradeDef).perSecond = perSecond))}
      />
      <BatchBuyEditor
        value={upgrade.buyAmount}
        pathPrefix={`up.${id}`}
        onChange={(buyAmount) => commit('up-buyAmount', (d) => void ((d as UpgradeDef).buyAmount = buyAmount), `${id}.buyAmount`)}
      />

      <section className="form-section">
        <h3>{t('field.conditions')}</h3>
        <p className="muted">{t('upgrade.conditionsHint')}</p>
        {upgrade.conditions.map((condition, index) => (
          <div className="row-editor" key={`condition-${index}`}>
            <NumExprField
              label={`${t('field.conditions')} ${index + 1}`}
              value={condition}
              context="condition"
              snippetBase={`up.${id}`}
              onChange={(next) =>
                commit(
                  'up-condition',
                  (draft) => {
                    const def = draft as UpgradeDef
                    def.conditions[index] = next
                  },
                  `${id}.conditions[${index}]`,
                )
              }
            />
            <button
              type="button"
              className="icon-btn danger"
              aria-label={t('common.remove')}
              onClick={() =>
                commit('up-remove-condition', (draft) => {
                  const def = draft as UpgradeDef
                  def.conditions = def.conditions.filter((_, i) => i !== index)
                })
              }
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() =>
            commit('up-add-condition', (draft) => {
              const def = draft as UpgradeDef
              def.conditions = [...def.conditions, 'true']
            })
          }
        >
          + {t('field.conditions')}
        </button>
      </section>

      <section className="form-section">
        <h3>{t('field.costs')}</h3>
        {upgrade.costs.map((row, index) => (
          <div className="row-editor" key={`cost-${index}`}>
            <RefPicker
              label={`${t('field.costs')} ${index + 1}`}
              value={row.materialId}
              allowed={['resource']}
              project={project}
              onChange={(materialId) =>
                commit(
                  'up-cost',
                  (draft) => {
                    const def = draft as UpgradeDef
                    const target = def.costs[index]
                    if (target) target.materialId = materialId
                  },
                  `${id}.costs[${index}].materialId`,
                )
              }
            />
            <NumExprField
              label={`${t('field.costs')} ${index + 1} · ${t('field.amount')}`}
              value={row.amount}
              context="price"
              snippetBase={`up.${id}`}
              onChange={(amount) =>
                commit(
                  'up-cost',
                  (draft) => {
                    const def = draft as UpgradeDef
                    const target = def.costs[index]
                    if (target) target.amount = amount
                  },
                  `${id}.costs[${index}].amount`,
                )
              }
            />
            <button
              type="button"
              className="icon-btn danger"
              aria-label={t('common.remove')}
              onClick={() =>
                commit('up-remove-cost', (draft) => {
                  const def = draft as UpgradeDef
                  def.costs = def.costs.filter((_, i) => i !== index)
                })
              }
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn"
          onClick={() =>
            commit('up-add-cost', (draft) => {
              const def = draft as UpgradeDef
              def.costs = [...def.costs, { materialId: '', amount: '1' }]
            })
          }
        >
          + {t('field.costs')}
        </button>
      </section>

      <section className="form-section">
        <h3>{t('field.effects')}</h3>
        <p className="muted">
          每条效果独立判断，满足前提的**全部生效**（不短路，PRD 升级编辑器 12 / D-23）； 只有 `owned &gt; 0` 的升级才产生效果（D-43）。
        </p>
        {upgrade.effects.map((effect, index) => (
          <div className="effect-editor" key={`effect-${index}`} data-testid={`effect-${index}`}>
            {/* 序号与删除按钮独占一行（`.effect-editor-head`）：原先它们是并排四列里的第四列，
                两条表达式被挤成两小格——见 `editor.css` 的 `.effect-editor` 注释。 */}
            <div className="effect-editor-head">
              <span className="effect-editor-index">
                {index + 1} / {upgrade.effects.length}
              </span>
              <button type="button" className="icon-btn danger" aria-label={t('common.remove')} onClick={() => removeEffect(index)}>
                ✕
              </button>
            </div>
            <NumExprField
              label={`${index + 1}. ${t('upgrade.effect.condition')}`}
              value={effect.condition}
              context="condition"
              snippetBase={`up.${id}`}
              onChange={(condition) => setEffect(index, { condition })}
            />
            <NumExprField
              label={`${index + 1}. ${t('upgrade.effect.action')}`}
              value={effect.action}
              context="effect"
              inlineHint={t('expr.textHint')}
              snippetBase={`up.${id}`}
              onChange={(action) => setEffect(index, { action })}
            />
            <div className="effect-value">
              <span className="effect-value-label">
                {t('upgrade.effect.value')}
                <span className="badge readonly" title={t('upgrade.effectValue.readonlyHint')}>
                  {t('upgrade.effectValue.readonly')}
                </span>
              </span>
              <output className="effect-value-number" data-testid={`effect-value-${index}`} title={t('upgrade.effectValue.readonlyHint')}>
                {effectValues[index] ?? '0'}
              </output>
              <span className="muted small">{effectValues[index] === undefined ? t('upgrade.effectValue.placeholder') : null}</span>
              <div className="chips">
                <button
                  type="button"
                  className="chip"
                  onClick={() => setEffect(index, { action: `effValue = ${effect.action === 'effValue = 0' ? 'gen.' + id + '.owned' : '0'}` })}
                >
                  {t('upgrade.effectValue.templateEff')}
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() =>
                    setEffect(index, {
                      action: `up.${id}.effectValues[${index}] = ${effect.action === `up.${id}.effectValues[${index}] = 0` ? `gen.${id}.owned` : '0'}`,
                    })
                  }
                >
                  {t('upgrade.effectValue.templatePath')}
                </button>
              </div>
            </div>
          </div>
        ))}
        <button type="button" className="btn" onClick={addEffect}>
          + {t('field.effects')}
        </button>
      </section>
    </div>
  )
}

/** 升级工作区（7.6）。 */
export function UpgradeWorkspace(props: { project: ProjectFile; selectedId: string | null; onSelect(id: string): void }) {
  const { project, selectedId, onSelect } = props
  const selected = project.upgrades.find((item) => item.id === selectedId) ?? null
  return (
    <div className="workspace">
      <EntryList
        kind="upgrade"
        title={t('list.upgrades')}
        items={project.upgrades}
        selectedId={selectedId}
        onSelect={onSelect}
        onAdd={() => addEntry('upgrade')}
        onMove={(id, direction) => moveEntry('upgrade', id, direction)}
        onDuplicate={(id) => duplicateEntry('upgrade', id)}
        onDelete={(id) => requestDeleteFor('upgrade', id)}
      />
      <div className="workspace-form">
        {selected ? <UpgradeForm upgrade={selected} project={project} /> : <p className="muted pad">{t('list.empty')}</p>}
      </div>
    </div>
  )
}
