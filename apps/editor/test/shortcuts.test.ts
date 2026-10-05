/**
 * 全局快捷键（TECH_DESIGN 7.1「全局快捷键」表、7.1 末条）。
 *
 * 7.1 末条是本模块的设计约束：快捷键触发的保存/撤销/重做与按钮点击**走同一条 store 事务**，
 * 不存在旁路实现。因此本文件只断言两件事：
 * 1. 组合键**识别**正确（含 `Ctrl` 与 `Cmd` 两种修饰键、Shift 变体）；
 * 2. 输入框内的按键**不**触发全局快捷键——否则打字会撤销/保存，是最容易被忽略的回归。
 *
 * `Space` 的范围与别处不同：只在**预览区容器聚焦时**才切换暂停（7.1 表末行）。
 */
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderHook } from '@testing-library/react'

import { useShortcuts } from '../src/app/shortcuts.js'
import type { ShortcutHandlers } from '../src/app/shortcuts.js'

/** 挂载 hook 并返回一组 spy。 */
function mount(): ShortcutHandlers & { key(key: string, init?: Partial<KeyboardEventInit>): void } {
  const handlers: ShortcutHandlers = {
    onSave: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onImport: vi.fn(),
    onExport: vi.fn(),
    onPackage: vi.fn(),
    onTogglePause: vi.fn(),
  }
  renderHook(() => useShortcuts(handlers))
  return {
    ...handlers,
    key(key: string, init: Partial<KeyboardEventInit> = {}) {
      // 真实浏览器里 `keydown` 的 `target` 是**当前焦点元素**，然后冒泡到 window。
      // 直接往 window 派发会让 `event.target === window`，`isEditable` 恒为假——
      // 那样就测不到“输入框内不触发快捷键”这条规则了。
      const target = document.activeElement ?? document.body
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
      })
    },
  }
}

/** 造一个处于焦点内的输入框，并让它成为 `document.activeElement`。 */
function focusInput(tag: 'input' | 'textarea' | 'select'): HTMLElement {
  const el = document.createElement(tag)
  document.body.append(el)
  el.focus()
  return el
}

/** 造一个 `contenteditable` 元素并聚焦。 */
function focusEditable(): HTMLElement {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  document.body.append(el)
  el.focus()
  return el
}

describe('带 Ctrl/Cmd 的全局快捷键（7.1 表）', () => {
  it('Ctrl+S -> 保存', () => {
    const h = mount()
    h.key('s', { ctrlKey: true })
    expect(h.onSave).toHaveBeenCalledTimes(1)
    expect(h.onUndo).not.toHaveBeenCalled()
  })

  it('Cmd+S（macOS）-> 保存', () => {
    const h = mount()
    h.key('s', { metaKey: true })
    expect(h.onSave).toHaveBeenCalledTimes(1)
  })

  it('大写字母也识别（`Ctrl+Shift+S` 不应漏掉保存）', () => {
    const h = mount()
    h.key('S', { ctrlKey: true })
    expect(h.onSave).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+Z -> 撤销', () => {
    const h = mount()
    h.key('z', { ctrlKey: true })
    expect(h.onUndo).toHaveBeenCalledTimes(1)
    expect(h.onRedo).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+Z -> 重做', () => {
    const h = mount()
    h.key('z', { ctrlKey: true, shiftKey: true })
    expect(h.onRedo).toHaveBeenCalledTimes(1)
    expect(h.onUndo).not.toHaveBeenCalled()
  })

  it('Ctrl+Y -> 重做', () => {
    const h = mount()
    h.key('y', { ctrlKey: true })
    expect(h.onRedo).toHaveBeenCalledTimes(1)
    expect(h.onUndo).not.toHaveBeenCalled()
  })

  it('Ctrl+O -> 导入；Ctrl+E -> 导出；Ctrl+P -> 打包', () => {
    const h = mount()
    h.key('o', { ctrlKey: true })
    h.key('e', { ctrlKey: true })
    h.key('p', { ctrlKey: true })
    expect(h.onImport).toHaveBeenCalledTimes(1)
    expect(h.onExport).toHaveBeenCalledTimes(1)
    expect(h.onPackage).toHaveBeenCalledTimes(1)
  })

  it('未绑定的组合键静默忽略（不调任何动作，也不阻止默认）', () => {
    const h = mount()
    const event = new KeyboardEvent('keydown', { key: 'q', ctrlKey: true, cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(h.onSave).not.toHaveBeenCalled()
    expect(h.onUndo).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('已绑定的组合键会 `preventDefault()`（拦住浏览器默认保存）', () => {
    const h = mount()
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })
    void h
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('没有修饰键时只有 Space 生效（7.1 表末行）', () => {
  it('Space 在预览区容器内聚焦时切换暂停', () => {
    const pane = document.createElement('div')
    pane.setAttribute('data-preview-pane', '')
    const button = document.createElement('button')
    pane.append(button)
    document.body.append(pane)
    button.focus()

    const h = mount()
    h.key(' ', {})
    expect(h.onTogglePause).toHaveBeenCalledTimes(1)
  })

  it('焦点不在预览区容器内时不切换暂停', () => {
    const pane = document.createElement('div')
    pane.setAttribute('data-preview-pane', '')
    document.body.append(pane)
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()

    const h = mount()
    h.key(' ', {})
    expect(h.onTogglePause).not.toHaveBeenCalled()
  })

  it('页面上没有预览区容器时不抛错（`nav` 到别的视图也不会坏）', () => {
    const h = mount()
    expect(() => h.key(' ', {})).not.toThrow()
    expect(h.onTogglePause).not.toHaveBeenCalled()
  })

  it('无修饰键的其它键一律不触发全局动作', () => {
    const h = mount()
    h.key('s', {})
    h.key('z', {})
    h.key('p', {})
    expect(h.onSave).not.toHaveBeenCalled()
    expect(h.onUndo).not.toHaveBeenCalled()
    expect(h.onPackage).not.toHaveBeenCalled()
  })
})

describe('输入框内不触发全局快捷键（否则打字会撤销/保存）', () => {
  it('`<input>` 内 Ctrl+Z / Ctrl+O / Ctrl+E 都不触发', () => {
    focusInput('input')
    const h = mount()
    h.key('z', { ctrlKey: true })
    h.key('o', { ctrlKey: true })
    h.key('e', { ctrlKey: true })
    expect(h.onUndo).not.toHaveBeenCalled()
    expect(h.onImport).not.toHaveBeenCalled()
    expect(h.onExport).not.toHaveBeenCalled()
  })

  it('`<textarea>` 内同样不触发', () => {
    focusInput('textarea')
    const h = mount()
    h.key('z', { ctrlKey: true })
    h.key('o', { ctrlKey: true })
    expect(h.onUndo).not.toHaveBeenCalled()
    expect(h.onImport).not.toHaveBeenCalled()
  })

  it('`<select>` 内同样不触发', () => {
    focusInput('select')
    const h = mount()
    h.key('e', { ctrlKey: true })
    expect(h.onExport).not.toHaveBeenCalled()
  })

  it('`contenteditable` 内同样不触发', () => {
    focusEditable()
    const h = mount()
    h.key('z', { ctrlKey: true })
    expect(h.onUndo).not.toHaveBeenCalled()
  })

  it('`Ctrl+S` 在输入框内**仍然**生效（保存是例外）', () => {
    focusInput('input')
    const h = mount()
    h.key('s', { ctrlKey: true })
    expect(h.onSave).toHaveBeenCalledTimes(1)
    h.key('z', { ctrlKey: true })
    expect(h.onUndo).not.toHaveBeenCalled()
  })

  it('输入框内 Space 不切换暂停', () => {
    const pane = document.createElement('div')
    pane.setAttribute('data-preview-pane', '')
    const input = document.createElement('input')
    pane.append(input)
    document.body.append(pane)
    input.focus()
    const h = mount()
    h.key(' ', {})
    expect(h.onTogglePause).not.toHaveBeenCalled()
  })
})

describe('生命周期', () => {
  it('卸载后不再监听（不残留全局监听器）', () => {
    const handlers: ShortcutHandlers = {
      onSave: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onImport: vi.fn(),
      onExport: vi.fn(),
      onPackage: vi.fn(),
      onTogglePause: vi.fn(),
    }
    const { unmount } = renderHook(() => useShortcuts(handlers))
    unmount()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
    })
    expect(handlers.onSave).not.toHaveBeenCalled()
  })
})
