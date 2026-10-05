/**
 * 条目引用选择器（TECH_DESIGN 7.6「RefPicker（条目引用搜索）」、6.4 引用完整性）。
 *
 * 用途有两处，规则不同：
 * - **购买材料**（`costs[i].materialId`）：只能指向**资源**（6.4「购买材料只指向资源」）；
 * - **产出目标**（`produces[i].materialId`）：可以是资源**或生成器**（PRD 生成器编辑器 10，
 *   产出到其它生成器不影响其价格）。
 *
 * 因此本组件按 `allowed` 过滤候选项；已存在的引用若因悬空而不在候选里（7.5 的删除弹窗会留下
 * 这种文本），仍原样显示并标红，让作者看见问题而不是被静默改写。
 *
 * ## “未设置”必须是一个**显式可见的状态**（不是“自动选中第一个候选”）
 *
 * `GeneratorForm` 新增一行价格/产出时 `materialId` 是空串，而 `<select>` 里**没有**
 * `value === ""` 的 `<option>`。浏览器在“当前值匹配不到任何 option”时会把
 * **第一个 option 显示为选中项**，于是界面上写着“矿石（r1）”，实际存的是 `""`。
 *
 * 后果不是“看着别扭”而是**静默改坏游戏**：运行时把解析不出目标的引用当成“没有价格 /
 * 没有产出”（D-07 的逐行跳过），于是生成器**免费可买**又**永不产出**，
 * 作者在预览里只看到一张没有价格行的可点卡片。
 *
 * 因此这里始终渲染一个 `value=""` 的“未设置”项，并把空值一并标成无效
 * （`aria-invalid` + 错误文案），让“还没选”和“选好了”在界面上是两件不同的事。
 */
import { useMemo, useState } from 'react'

import { t } from '@iforge/i18n'
import type { EntryKind, ProjectFile } from '@iforge/model'

export interface RefPickerProps {
  label: string
  value: string
  onChange(value: string): void
  project: ProjectFile
  /** 允许引用的条目类型。 */
  allowed: readonly EntryKind[]
  /** 引用悬空时展示的说明（6.4 的 `E_DANGLING_REF`）。 */
  danglingHint?: string
  disabled?: boolean
}

export function RefPicker({ label, value, onChange, project, allowed, danglingHint, disabled }: RefPickerProps) {
  const [keyword, setKeyword] = useState('')

  const candidates = useMemo(() => {
    const all: Array<{ id: string; name: string; kind: EntryKind }> = [
      ...project.resources.map((item) => ({ id: item.id, name: item.name, kind: 'resource' as const })),
      ...project.generators.map((item) => ({ id: item.id, name: item.name, kind: 'generator' as const })),
      ...project.upgrades.map((item) => ({ id: item.id, name: item.name, kind: 'upgrade' as const })),
    ]
    return all.filter((item) => allowed.includes(item.kind)).filter((item) => item.name.includes(keyword.trim()))
  }, [project, allowed, keyword])

  // “还没选”与“指向已删除的条目”是两种不同的坏，都必须在界面上看得见。
  const unset = value.trim() === ''
  const dangling = !unset && !candidates.some((item) => item.id === value)
  const invalid = unset || dangling

  return (
    <div className="ref-picker">
      <span className="ref-label">{label}</span>
      <input
        className="input"
        type="search"
        value={keyword}
        placeholder={t('common.search')}
        aria-label={t('common.search')}
        disabled={disabled}
        onChange={(event) => setKeyword(event.target.value)}
      />
      <select
        className="input"
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-invalid={invalid || undefined}
        data-unset={unset ? 'true' : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {/* 必须在最前面且 `value=""`：没有它时空值会“显示成”第一个候选（见文件头注释）。 */}
        <option value="">{`⚠ ${t('common.unset')}`}</option>
        {dangling ? <option value={value}>{`⚠ ${value}`}</option> : null}
        {value !== '' && !dangling ? <option value={value}>{value}</option> : null}
        {candidates
          .filter((item) => item.id !== value)
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}（{item.id}）
            </option>
          ))}
      </select>
      {unset ? (
        <p className="field-error" data-testid="ref-unset">
          {`E_DANGLING_REF：${t('common.unset')}（${t('ref.mustPick')}）`}
        </p>
      ) : null}
      {dangling ? <p className="field-error">{danglingHint ?? `E_DANGLING_REF: ${value}`}</p> : null}
    </div>
  )
}
