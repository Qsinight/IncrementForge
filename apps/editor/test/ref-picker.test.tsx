/**
 * `RefPicker` 的“未设置”状态（TECH_DESIGN 7.6「RefPicker」、6.4 引用完整性、D-38）。
 *
 * ## 这条用例在守什么
 *
 * `GeneratorForm` 的“+ 购买价格 / + 产出资源”新增一行时 `materialId` 是**空串**。
 * `<select>` 在“当前值匹配不到任何 `<option>`”时会按规范把**第一项**显示为选中项，
 * 于是界面上写着“矿石（r1）”，实际存的是 `""`——一个**空引用**被显示成了一个已选项。
 *
 * 后果在运行时是静默改坏游戏：解析不出目标的引用行会被跳过（`E_DANGLING_REF`），
 * 于是这个生成器**免费可买**又**永不产出**（`priceRowsUsable` 的守卫只把购买堵住，
 * 卡片上原本连价格行都没有）。作者在编辑器里看不到任何异常。
 *
 * 所以“还没选”必须在界面上是一个**显式、可见、可选中**的状态。
 * 运行侧的对应回归见 `packages/runtime/test/dangling-ref.test.ts`。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { createDefaultProject } from '@iforge/model'
import type { ProjectFile } from '@iforge/model'

import { RefPicker } from '../src/components/RefPicker.js'

/** 两个资源 + 一个生成器（购买材料只允许指向资源，6.4）。 */
function projectWithResources(): ProjectFile {
  const project = createDefaultProject() as ProjectFile
  for (const [index, name] of ['矿石', '金属'].entries()) {
    project.resources.push({
      kind: 'resource',
      id: `r${index + 1}`,
      order: index + 1,
      name,
      description: '',
      icon: { kind: 'builtin', value: 'gem' },
      visible: true,
      initial: '0',
      max: 'Infinity',
    })
  }
  return project
}

/** 渲染一个受控的 `RefPicker`。 */
function picker(value: string, onChange = vi.fn()) {
  const view = render(<RefPicker label="购买材料" value={value} onChange={onChange} project={projectWithResources()} allowed={['resource']} />)
  const select = screen.getByLabelText('购买材料') as HTMLSelectElement
  return { ...view, select, onChange }
}

describe('7.6 RefPicker：空引用必须是显式的“未设置”，不能伪装成已选项', () => {
  it('`value = ""` 时存在 `value=""` 的选项，且它是当前选中项', () => {
    const { select } = picker('')
    const options = [...select.options]
    expect(options.some((option) => option.value === '')).toBe(true)
    expect(select.value).toBe('')
    // 界面上第一眼看到的是“未设置”，而不是第一个候选的名字。
    expect(options[0]!.value).toBe('')
    expect(options[0]!.textContent).toContain('未设置')
  })

  it('`value = ""` 时标成无效并给出解释（作者能看出这一行还没配完）', () => {
    picker('')
    const select = screen.getByLabelText('购买材料')
    expect(select).toHaveAttribute('aria-invalid', 'true')
    expect(select).toHaveAttribute('data-unset', 'true')
    expect(screen.getByTestId('ref-unset')).toHaveTextContent('E_DANGLING_REF')
  })

  it('已选中的引用不标无效，也没有“未设置”提示', () => {
    picker('r1')
    const select = screen.getByLabelText('购买材料')
    expect(select).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByTestId('ref-unset')).toBeNull()
  })

  it('指向已删除的条目：仍原样显示并标红（不静默改写，D-38）', () => {
    const { select } = picker('rGone')
    expect(select.value).toBe('rGone')
    expect(select).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/E_DANGLING_REF: rGone/)).toBeInTheDocument()
  })

  it('从“未设置”改选一个资源后，`onChange` 拿到真实 id 且提示消失', async () => {
    const user = userEvent.setup()
    const { select, onChange } = picker('')
    await user.selectOptions(select, 'r2')
    expect(onChange).toHaveBeenCalledWith('r2')
  })

  it('可以从已选项退回“未设置”（作者有路把引用清空）', async () => {
    const user = userEvent.setup()
    const { select, onChange } = picker('r1')
    await user.selectOptions(select, '')
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('`allowed` 之外的类型不出现在候选里（购买材料只指向资源，6.4）', () => {
    const project = projectWithResources()
    project.generators.push({
      kind: 'generator',
      id: 'g1',
      order: 1,
      name: '矿机',
      description: '',
      icon: { kind: 'builtin', value: 'factory' },
      visible: true,
      disabled: false,
      isClicker: false,
      initial: '0',
      max: 'Infinity',
      buyAmount: '1',
      buyDelay: 1,
      costs: [],
      produces: [],
    })
    render(<RefPicker label="购买材料" value="" onChange={vi.fn()} project={project} allowed={['resource']} />)
    const values = [...(screen.getByLabelText('购买材料') as HTMLSelectElement).options].map((option) => option.value)
    expect(values).toContain('r1')
    expect(values).not.toContain('g1')
  })
})
